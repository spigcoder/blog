---
title: "上下文切换：进程上下文与内核上下文"
date: 2026-08-23
tags: ["操作系统", "上下文切换", "Linux", "调度"]
excerpt: "从 CPU 虚拟化出发，理解进程上下文切换与内核上下文切换的区别，并结合 Linux 调度源码分析 __schedule、context_switch 与 switch_to 的实现。"
---

# 上下文切换：进程上下文与内核上下文

学习 CPU 虚拟化时，一个绕不开的重要概念就是上下文切换，借此机会把相关知识系统梳理一遍。

## 为什么需要上下文切换

这个问题要分类讨论，因为操作系统里存在两种容易混淆的"切换"：

1. **进程上下文切换**：它是实现 CPU 虚拟化的关键。CPU 虚拟化指的是用一台物理 CPU 同时运行多个进程，让每个进程都觉得自己独占一个 CPU，靠的是时分复用——每个进程运行一小段时间后换另一个进程运行。为了在下次调度回来时能接着上次的状态继续跑，就必须把进程的寄存器现场保存下来，这就是进程上下文切换。
2. **内核上下文切换**：它源于操作系统把权限分为内核态与用户态，目的是保证安全性，防止恶意程序侵入系统。一般发生在系统调用或时钟中断时：CPU 进入内核态，把用户态寄存器压入内核栈，同时切换 CPU 权限级别；系统调用返回时再出栈恢复寄存器，继续执行用户态代码。

## 触发上下文切换的场景

在 Linux 中，发生上下文切换的场景主要有：

- **Timer tick**：运行时间片耗尽；
- **Wakeup**：有更高优先级的进程被唤醒；
- **Explicit yield**：进程主动放弃 CPU；
- **Priority change**：有更高优先级的进程被创建。

同时，切换还分为两类：

- **自愿切换**：等待锁、I/O 阻塞、sleep 等主动让出 CPU；
- **非自愿切换**：被调度器抢占。

```shell
# 查看某个进程的自愿/非自愿上下文切换次数
cat /proc/$PID/status | grep ctxt
# voluntary_ctxt_switches:    1234
# nonvoluntary_ctxt_switches: 567
```

由此也可以推断：如果一个进程的非自愿切换次数很高，通常说明系统 CPU 负载较高，进程被频繁打断。

## 调度入口：__schedule

调度的核心代码如下：

```c
// kernel/sched/core.c (simplified)
static void __sched notrace __schedule(int sched_mode)
{
    struct task_struct *prev, *next;
    struct rq *rq;
    int cpu;

    cpu = smp_processor_id();
    rq = cpu_rq(cpu);
    prev = rq->curr;

    // 1. 关闭中断并锁住运行队列
    local_irq_disable();
    rcu_note_context_switch(sched_mode == SM_PREEMPT);
    rq_lock(rq, &rf);

    // 2. 更新运行队列时钟
    update_rq_clock(rq);

    // 3. 若是主动切换且进程状态非运行态（正在睡眠/阻塞），
    //    把它从运行队列摘除。
    //    TASK_RUNNING == 0，所以 prev->__state 非 0 表示进程已主动
    //    把自己置为睡眠态，属于自愿切换；仍为 0 则是被抢占。
    if (!(sched_mode & SM_MASK_PREEMPT) && prev->__state) {
        // 进程即将睡眠，移出运行队列
        try_to_block_task(rq, prev, &rf);
        switch_count = &prev->nvcsw;  // 自愿切换
    } else {
        switch_count = &prev->nivcsw; // 非自愿切换
    }

    // 4. 清除重新调度标志
    clear_tsk_need_resched(prev);
    clear_preempt_need_resched();

    // 5. 选出下一个要运行的任务
    next = pick_next_task(rq, prev, &rf);

    // 6. 如果还是同一个任务，就不用切换
    if (likely(prev != next)) {
        rq->nr_switches++;
        rq->curr = next;
        ++*switch_count;

        // 7. 真正的切换！
        context_switch(rq, prev, next, &rf);
        // --- 从这里返回时，已经运行在 next 的上下文中 ---
    } else {
        rq_unpin_lock(rq, &rf);
        __balance_callbacks(rq);
        raw_spin_rq_unlock_irq(rq);
    }
}
```

## 上下文切换的核心：context_switch

```c
// kernel/sched/core.c
static __always_inline struct rq *context_switch(struct rq *rq, struct task_struct *prev,
                      struct task_struct *next, struct rq_flags *rf)
{
    // 1. 切换前的准备工作（tracing、perf、cgroup 通知等）
    prepare_task_switch(rq, prev, next);

    // 2. 切换地址空间
    if (!next->mm) {
        // 内核线程：借用 prev 的页表（lazy TLB），因为内核线程的 mm 为空
        next->active_mm = prev->active_mm;
        enter_lazy_tlb(prev->active_mm, next);
    } else {
        // 用户进程：加载 next 的页表
        switch_mm_irqs_off(prev->active_mm, next->mm, next);
    }

    // 3. 切换 CPU 寄存器与内核栈
    switch_to(prev, next, prev);
    // ↑ 这一行之后，已经运行在 next 的上下文中

    barrier();

    // 4. 切换后的收尾工作（运行在 next 的上下文中）
    return finish_task_switch(prev);
}
```

## 汇编层面的切换：__switch_to_asm

```assembly
// x86-64 下简化版的 __switch_to_asm
__switch_to_asm:
    // 保存 prev 的 callee-saved 寄存器
    pushq %rbp
    pushq %rbx
    pushq %r12
    pushq %r13
    pushq %r14
    pushq %r15

    // 把 prev 的栈顶指针存到 task_struct->thread.sp
    movq %rsp, TASK_threadsp(%rdi)     // rdi = prev

    // 从 next 的 thread.sp 恢复新的栈顶指针
    movq TASK_threadsp(%rsi), %rsp     // rsi = next

    // 恢复 next 的 callee-saved 寄存器
    popq %r15
    popq %r14
    popq %r13
    popq %r12
    popq %rbx
    popq %rbp

    // 跳到 __switch_to（C 函数）处理 FPU/调试寄存器等
    jmp __switch_to
```

## 两个关键结论

1. 切换到内核线程和切换到用户进程发生在同一个 `context_switch` 函数里，只是通过 `next->mm` 是否为空的判断来区分：内核线程没有自己的用户地址空间（`mm == NULL`），所以借用 prev 的页表，不切换页表；用户进程则通过 `switch_mm_irqs_off` 切换页表。
2. `task_struct` 里保存的是内核栈相关的寄存器（栈顶指针等），而用户态的寄存器现场（系统调用、中断时压栈的那些）都保存在对应进程的内核栈中。
