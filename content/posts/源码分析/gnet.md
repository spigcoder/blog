---
title: "gnet 源码解析：Reactor、eventfd 与异步写"
tags: ["Go", "gnet", "源码分析", "Reactor", "网络编程"]
excerpt: "从 gnet 的启动流程、Reactor 模型、eventloop、poller 唤醒机制和异步写路径出发，理解一个高性能事件驱动网络框架如何组织 I/O 线程与业务回调。"
---

# gnet 源码解析：Reactor、eventfd 与异步写

高性能网络框架通常要处理两个互相拉扯的目标：一方面，I/O 线程要尽量少阻塞，持续从内核拿事件、读数据、写数据；另一方面，真实业务里又经常有编解码、状态更新、RPC、数据库访问等计算或阻塞操作。如果把这些工作都放在 I/O 线程里做，事件循环就会停在某个连接上，其他连接即使已经就绪，也只能等待。

gnet 的设计正是围绕这个问题展开。它把网络 I/O 组织成事件循环，让连接读写尽量发生在所属的 event-loop 中；如果业务需要在其他 goroutine 里处理结果，再通过 `AsyncWrite`、`Wake`、`CloseWithCallback` 这类并发安全接口把任务交回 event-loop。要理解 gnet 的关键，不是单独记住某个函数，而是看清楚连接、事件、任务如何在不同 goroutine 之间回到同一个 I/O 所属线程。

本文以 Go 开源项目 `github.com/panjf2000/gnet/v2` 的 Unix/Linux 路径为主，参考版本为 `v2.4.1-93-g0c3e6f82`。后文重点分析 `Run`、`engine`、`eventloop`、`netpoll.Poller`、`conn` 和异步写路径；Windows IOCP、UDP 细节和 `poll_opt` 优化路径不展开。

## 先理解 gnet 的事件模型

传统 Go 网络服务经常采用 goroutine-per-connection 模型：每个连接一个 goroutine 阻塞读写，代码直观，和标准库 `net.Conn` 配合自然。gnet 走的是另一条路，它是事件驱动框架：少量 event-loop goroutine 监听大量 fd，某个 fd 可读或可写时，event-loop 执行对应的回调。

这种模型的好处是减少 goroutine 和调度开销，把连接状态集中在 event-loop 内管理；代价是业务回调必须克制。`OnTraffic`、`OnOpen`、`OnClose` 这类回调运行在 event-loop 里，如果回调里做长时间阻塞操作，就会阻塞整个 event-loop，而不只是阻塞当前连接。

gnet 在公开接口上已经把这个边界写得很清楚。`Reader` 和部分 `Writer` 方法都要求在 `EventHandler` 方法内调用，不保证并发安全；`AsyncWrite`、`AsyncWritev`、`Wake`、`CloseWithCallback` 则是并发安全的，可以从其他 goroutine 调用。这个区分背后的实现，就是本文要看的主线。

## 启动入口：Run 只是把 engine 跑起来

`gnet.Run` 是服务启动入口。它先解析监听地址，创建 listener，再进入内部的 `run`：

```go
func Run(eventHandler EventHandler, protoAddr string, opts ...Option) error {
	listeners, options, err := createListeners([]string{protoAddr}, opts...)
	if err != nil {
		return err
	}
	defer func() {
		for _, ln := range listeners {
			ln.close()
		}
		logging.Cleanup()
	}()
	return run(eventHandler, listeners, options, []string{protoAddr})
}
```

真正重要的是 `run`。它决定 event-loop 数量，创建 `engine`，初始化负载均衡器，触发用户的 `OnBoot`，然后调用 `eng.start` 启动事件循环：

```go
func run(eventHandler EventHandler, listeners []*listener, options *Options, addrs []string) error {
	numEventLoop := determineEventLoops(options)

	lns := make(map[int]*listener, len(listeners))
	for _, ln := range listeners {
		lns[ln.fd] = ln
	}
	rootCtx, shutdown := context.WithCancel(context.Background())
	eg, ctx := errgroup.WithContext(rootCtx)
	eng := engine{
		listeners:    lns,
		opts:         options,
		turnOff:      shutdown,
		eventHandler: eventHandler,
		concurrency:  struct{ *errgroup.Group; ctx context.Context }{eg, ctx},
	}

	switch options.LB {
	case RoundRobin:
		eng.eventLoops = new(roundRobinLoadBalancer)
	case LeastConnections:
		eng.eventLoops = new(leastConnectionsLoadBalancer)
	case SourceAddrHash:
		eng.eventLoops = new(sourceAddrHashLoadBalancer)
	}

	e := Engine{&eng}
	if eng.eventHandler.OnBoot(e) == Shutdown {
		return nil
	}
	if err := eng.start(ctx, numEventLoop); err != nil {
		eng.closeEventLoops()
		return err
	}
	defer eng.stop(rootCtx, e)

	return nil
}
```

这里的 `engine` 是全局运行上下文：它持有 listener、配置、用户回调、event-loop 集合、主 reactor 和关闭信号。gnet 后续所有连接接受、事件分发、异步任务执行，都会围绕这个结构展开。

## 两种启动模式：ReusePort 决定 Reactor 形态

Unix 路径下，`engine.start` 根据 `ReusePort` 选择两种不同模式：

```go
func (eng *engine) start(ctx context.Context, numEventLoop int) error {
	if eng.opts.ReusePort {
		return eng.runEventLoops(ctx, numEventLoop)
	}
	return eng.activateReactors(ctx, numEventLoop)
}
```

开启 `ReusePort` 时，每个 event-loop 都可以有自己的监听 socket，内核负责把新连接分配给不同 socket。此时 gnet 采用更扁平的模型：每个 event-loop 既负责 accept，也负责处理自己名下连接的 I/O。

不开启 `ReusePort` 时，gnet 采用主从 Reactor。`activateReactors` 会先创建多个 sub reactor，它们只处理已分配连接的 I/O；然后创建一个 `idx = -1` 的 ingress event-loop 作为 main reactor，专门监听 listener，accept 到新连接后再交给某个 sub reactor。

```go
func (eng *engine) activateReactors(ctx context.Context, numEventLoop int) error {
  // SubReactor
	for i := 0; i < numEventLoop; i++ {
		p, err := netpoll.OpenPoller()
		if err != nil {
			return err
		}
		el := new(eventloop)
		el.listeners = eng.listeners
		el.engine = eng
		el.poller = p
		el.buffer = make([]byte, eng.opts.ReadBufferCap)
		el.connections.init()
		el.eventHandler = eng.eventHandler
		eng.eventLoops.register(el)
	}

	eng.eventLoops.iterate(func(_ int, el *eventloop) bool {
		eng.concurrency.Go(el.orbit)
		return true
	})

  //主 Reactor
	p, err := netpoll.OpenPoller()
	if err != nil {
		return err
	}
	el := new(eventloop)
	el.listeners = eng.listeners
	el.idx = -1
	el.engine = eng
	el.poller = p
	el.eventHandler = eng.eventHandler
	for _, ln := range eng.listeners {
		if err = el.poller.AddRead(ln.packPollAttachment(el.accept0), true); err != nil {
			return err
		}
	}
	eng.ingress = el
	eng.concurrency.Go(el.rotate)
	return nil
}
```

这段代码解释了 gnet 的宏观分工：main reactor 负责接入，sub reactor 负责连接读写。负载均衡器决定新连接应该落到哪个 sub reactor 上，可以是轮询、最少连接或源地址哈希。

## accept 之后为什么要 Trigger

在主从 Reactor 模式下，main reactor accept 到连接后，并不会直接把这个 fd 注册到自己的 poller，而是选择一个 sub reactor，再通过目标 sub reactor 的 `poller.Trigger` 投递注册任务：

```go
func (el *eventloop) accept0(fd int, _ netpoll.IOEvent, _ netpoll.IOFlags) error {
	for {
		nfd, sa, err := socket.Accept(fd)
		if err == unix.EAGAIN {
			return nil
		}
		if err != nil {
			continue
		}

		remoteAddr := socket.SockaddrToTCPOrUnixAddr(sa)
		network := el.listeners[fd].network
    // 负载均衡
		el := el.engine.eventLoops.next(remoteAddr)
		c := newStreamConn(network, nfd, el, sa, el.listeners[fd].addr, remoteAddr)
		err = el.poller.Trigger(queue.HighPriority, el.register, c)
		if err != nil {
			_ = unix.Close(nfd)
			c.release()
		}
	}
}
```

这里的关键点是线程归属。连接被分配给某个 sub reactor 后，后续的读、写、关闭、回调都应尽量在这个 event-loop 中完成。main reactor 只是拿到了新连接 fd，真正把 fd 加入 poller、加入连接表、触发 `OnOpen` 的动作，要交给目标 event-loop 自己执行。

这也是为什么 `Trigger` 很重要。它解决的不是普通函数调用问题，而是跨 goroutine 向一个正在 `epoll_wait` 的 event-loop 投递任务，并让它尽快醒过来执行。

## eventfd：把任务队列接入 epoll

Linux 默认路径里，`netpoll.Poller` 同时持有 epoll fd、eventfd 和两个任务队列：

```go
type Poller struct {
	fd                   int
	efd                  int
	efdBuf               []byte
	wakeupCall           int32
	asyncTaskQueue       queue.AsyncTaskQueue
	urgentAsyncTaskQueue queue.AsyncTaskQueue
}
```

`OpenPoller` 创建 epoll 后，又创建了一个非阻塞 `eventfd`，并把它作为可读 fd 注册进 epoll：

```go
func OpenPoller() (poller *Poller, err error) {
	poller = new(Poller)
	poller.fd, err = unix.EpollCreate1(unix.EPOLL_CLOEXEC)
	if err != nil {
		return nil, os.NewSyscallError("epoll_create1", err)
	}
  // efd 作为唤醒 poller 的 fd
	poller.efd, err = unix.Eventfd(0, unix.EFD_NONBLOCK|unix.EFD_CLOEXEC)
	if err != nil {
		_ = poller.Close()
		return nil, os.NewSyscallError("eventfd", err)
	}
	poller.efdBuf = make([]byte, 8)
	if err = poller.AddRead(&PollAttachment{FD: poller.efd}, true); err != nil {
		_ = poller.Close()
		return nil, err
	}
	poller.asyncTaskQueue = queue.NewLockFreeQueue()
	poller.urgentAsyncTaskQueue = queue.NewLockFreeQueue()
	return poller, nil
}
```

这样做之后，event-loop 不只会被网络 fd 唤醒，也能被内部任务唤醒。其他 goroutine 调用 `Trigger` 时，任务先进入队列，然后向 eventfd 写入 8 字节。eventfd 变为可读，`epoll_wait` 返回，event-loop 就能在自己的 goroutine 中执行队列里的任务。

```go
func (p *Poller) Trigger(priority queue.EventPriority, fn queue.Func, param any) (err error) {
	task := queue.GetTask()
	task.Exec, task.Param = fn, param
	if priority > queue.HighPriority && p.urgentAsyncTaskQueue.Length() >= p.highPriorityEventsThreshold {
		p.asyncTaskQueue.Enqueue(task)
	} else {
		p.urgentAsyncTaskQueue.Enqueue(task)
	}
	if atomic.CompareAndSwapInt32(&p.wakeupCall, 0, 1) {
		for {
			_, err = unix.Write(p.efd, b)
			if err == unix.EAGAIN {
				_, _ = unix.Read(p.efd, p.efdBuf)
				continue
			}
			break
		}
	}
	return os.NewSyscallError("write", err)
}
```

`wakeupCall` 用来合并唤醒。短时间内连续投递多个任务时，不需要每个任务都写一次 eventfd；只要 event-loop 已经会被唤醒，后续任务进入队列即可。

`Polling` 中遇到 eventfd 事件时，不会调用网络回调，而是执行任务队列：

```go
func (p *Poller) Polling(callback PollEventHandler) error {
	for {
		n, err := unix.EpollWait(p.fd, el.events, msec)
		if err != nil {
			return err
		}

		for i := 0; i < n; i++ {
			ev := &el.events[i]
			if fd := int(ev.Fd); fd == p.efd {
				doChores = true
			} else {
				err = callback(fd, ev.Events, 0)
			}
		}

		if doChores {
			for task := p.urgentAsyncTaskQueue.Dequeue(); task != nil; task = p.urgentAsyncTaskQueue.Dequeue() {
				err = task.Exec(task.Param)
				queue.PutTask(task)
			}
			for i := 0; i < MaxAsyncTasksAtOneTime; i++ {
				task := p.asyncTaskQueue.Dequeue()
				if task == nil {
					break
				}
				err = task.Exec(task.Param)
				queue.PutTask(task)
			}
			atomic.StoreInt32(&p.wakeupCall, 0)
		}
	}
}
```

这就是 gnet 里“线程间通信”的核心：不是直接跨 goroutine 操作连接状态，而是把操作封装成任务，投递到连接所属 event-loop 的队列里，再用 eventfd 唤醒 epoll。

## eventloop 如何处理连接 I/O

sub reactor 的主循环在 `orbit`。它把 fd 事件转换为连接上的 `processIO`：

```go
func (el *eventloop) orbit() error {
	err := el.poller.Polling(func(fd int, ev netpoll.IOEvent, flags netpoll.IOFlags) error {
		c := el.connections.getConn(fd)
		if c == nil {
			return el.poller.Delete(fd)
		}
		return c.processIO(fd, ev, flags)
	})
	el.closeConns()
	el.engine.shutdown(err)
	return err
}
```

Linux 下的 `processIO` 会优先处理写事件，再处理读事件，最后处理对端关闭：

```go
func (c *conn) processIO(_ int, ev netpoll.IOEvent, _ netpoll.IOFlags) error {
	el := c.loop
	if ev&(netpoll.ErrEvents|unix.EPOLLRDHUP) != 0 && ev&netpoll.ReadWriteEvents == 0 {
		c.outboundBuffer.Release()
		return el.close(c, io.EOF)
	}
	if ev&(netpoll.WriteEvents|netpoll.ErrEvents) != 0 {
		if err := el.write(c); err != nil {
			return err
		}
	}
	if ev&(netpoll.ReadEvents|netpoll.ErrEvents) != 0 {
		if err := el.read(c); err != nil {
			return err
		}
	}
	if ev&unix.EPOLLRDHUP != 0 && c.opened {
		c.isEOF = true
		return el.read(c)
	}
	return nil
}
```

写事件优先不是偶然。源码注释里解释了两个场景：系统压力大时，先把已经准备好的响应写回去，可以减少积压；连接已经异常时，也要尽量把缓冲区里剩余的数据写出去，再关闭连接。

读路径则负责从 socket 读取数据，并调用用户的 `OnTraffic`：

```go
func (el *eventloop) read(c *conn) error {
	if !c.opened {
		return nil
	}

	var recv int
	isET := el.engine.opts.EdgeTriggeredIO
	chunk := el.engine.opts.EdgeTriggeredIOChunk
loop:
	n, err := unix.Read(c.fd, el.buffer)
	if err != nil || n == 0 {
		if err == unix.EAGAIN {
			return nil
		}
		if n == 0 {
			err = io.EOF
		}
		return el.close(c, os.NewSyscallError("read", err))
	}
	recv += n

	c.buffer = el.buffer[:n]
  // 执行 OnTraffic 函数
	action := el.eventHandler.OnTraffic(c)
	if action == Close {
		return el.close(c, nil)
	}
	if action == Shutdown {
		return errorx.ErrEngineShutdown
	}
	_, _ = c.inboundBuffer.Write(c.buffer)
	c.buffer = c.buffer[:0]

	if c.isEOF || (isET && recv < chunk) {
		goto loop
	}
	if isET && n == len(el.buffer) {
		return el.poller.Trigger(queue.LowPriority, el.read0, c)
	}
	return nil
}
```

这里有两个细节值得单独看。第一，`OnTraffic` 运行在 event-loop 中，因此业务逻辑不能阻塞。第二，gnet 的读缓冲分为当前这次读到的 `c.buffer` 和遗留数据 `inboundBuffer`。用户在 `OnTraffic` 中可以通过 `Next`、`Peek`、`Discard` 消费数据；回调结束后，如果还有未消费的 `c.buffer`，gnet 会把它写入 `inboundBuffer`，供下一次回调继续读取。

边缘触发模式下，gnet 还要防止单个连接一直读写，把整个 event-loop 占住。因此源码使用 `EdgeTriggeredIOChunk` 做阈值控制：如果本轮读写达到阈值但还有剩余数据，就通过 `Trigger` 投递下一轮读写任务，把执行权还给 event-loop，避免其他连接长期饥饿。

## 同步写：尽量直写，写不完再缓冲

`Conn.Write` 在 TCP/Unix 连接上会进入 `conn.write`。它的第一条规则是保持顺序：如果 `outboundBuffer` 里已经有待发送数据，新数据不能抢先写到 socket，只能追加到缓冲区后面。

```go
func (c *conn) write(data []byte) (n int, err error) {
	isET := c.loop.engine.opts.EdgeTriggeredIO
	n = len(data)
	if !c.outboundBuffer.IsEmpty() {
		_, _ = c.outboundBuffer.Write(data)
		return
	}

	var sent int
loop:
	if sent, err = unix.Write(c.fd, data); err != nil {
		if err == unix.EAGAIN {
			_, err = c.outboundBuffer.Write(data)
			if !isET {
				err = c.loop.poller.ModReadWrite(&c.pollAttachment, isET)
			}
			return
		}
		return 0, err
	}
	data = data[sent:]
	if isET && len(data) > 0 {
		goto loop
	}
	if len(data) > 0 {
		_, _ = c.outboundBuffer.Write(data)
		err = c.loop.poller.ModReadWrite(&c.pollAttachment, isET)
	}
	return
}
```

这段逻辑可以概括为：能写就直接写，写到内核返回 `EAGAIN` 或没写完，就把剩余数据放进 `outboundBuffer`，再注册可写事件。等 epoll 后续通知 `EPOLLOUT`，`eventloop.write` 会继续把缓冲区刷出去。

这也是为什么普通 `Write` 不并发安全。它直接操作连接的缓冲区和 poller 事件，应该在连接所属 event-loop 中调用，也就是在 `OnOpen`、`OnTraffic` 等回调里调用。

## AsyncWrite：从业务 goroutine 回到 event-loop

如果业务把耗时逻辑丢到其他 goroutine 里执行，完成后还想给连接写响应，就不能直接调用普通 `Write`。gnet 提供了并发安全的 `AsyncWrite`：

```go
func (c *conn) AsyncWrite(buf []byte, callback AsyncCallback) error {
	if c.isDatagram {
		_, err := c.sendTo(buf, nil)
		if callback != nil {
			_ = callback(nil, nil)
		}
		return err
	}
  // 加入到队列
	return c.loop.poller.Trigger(queue.HighPriority, c.asyncWrite, &asyncWriteHook{callback, buf})
}
```

它没有跨 goroutine 直接写 socket，而是把 `c.asyncWrite` 投递到连接所属 event-loop。event-loop 被 eventfd 唤醒后，在自己的 goroutine 中执行真正的写入：

```go
func (c *conn) asyncWrite(a any) (err error) {
	hook := a.(*asyncWriteHook)
	defer func() {
		if hook.callback != nil {
			_ = hook.callback(c, err)
		}
	}()

	if !c.opened {
		return net.ErrClosed
	}

	_, err = c.write(hook.data)
	return
}
```

这样一来，异步写和普通写最终复用了同一套 `c.write` 逻辑，也维护了同一个 `outboundBuffer` 顺序。区别只在入口：普通 `Write` 假设调用者已经在 event-loop 中；`AsyncWrite` 则负责把外部 goroutine 的写请求送回 event-loop。

`Wake` 和 `CloseWithCallback` 也是同一类设计。它们都通过 `poller.Trigger` 把任务交给连接所属 event-loop，避免外部 goroutine 直接修改连接状态。

## 注册外部连接也是同一套思路

`Engine.Register` 和 `EventLoop.Enroll` 支持把外部已有的 `net.Conn` 纳入 gnet 管理。这个流程里有一个容易忽略的点：它先在 worker pool 中完成可能阻塞的拨号或 fd 复制，再用 `poller.Trigger` 把最终注册动作交给 event-loop。

```go
func (el *eventloop) enroll(c net.Conn, addr net.Addr, ctx any) (resCh chan RegisteredResult, err error) {
	resCh = make(chan RegisteredResult, 1)
	err = goroutine.DefaultWorkerPool.Submit(func() {
		defer close(resCh)

		if c == nil {
			c, err = net.Dial(addr.Network(), addr.String())
			if err != nil {
				resCh <- RegisteredResult{Err: err}
				return
			}
		}

		// 省略 syscall.Conn、Dup 和 conn 构造过程

		connOpened := make(chan struct{})
		ccb := &connWithCallback{c: gc, cb: func() { close(connOpened) }}
		if err := el.poller.Trigger(queue.LowPriority, el.register, ccb); err != nil {
			gc.Close()
			resCh <- RegisteredResult{Err: err}
			return
		}
		<-connOpened
		resCh <- RegisteredResult{Conn: gc}
	})
	return
}
```

这段代码体现了 gnet 的边界意识：可能阻塞的操作放到 worker pool；连接状态注册仍然回到 event-loop。这样不会让 event-loop 因为 `net.Dial`、`SyscallConn`、`Dup` 等操作卡住。

## 关闭路径：先移除连接，再回调，再释放资源

连接关闭也必须在所属 event-loop 内收束。`eventloop.close` 会先检查连接是否仍然有效，再从连接表删除，调用用户 `OnClose`，尝试把残留的输出缓冲写回去，最后释放连接资源并从 poller 删除 fd：

```go
func (el *eventloop) close(c *conn, err error) error {
	if !c.opened || el.connections.getConn(c.fd) == nil {
		return nil
	}

	el.connections.delConn(c)
	action := el.eventHandler.OnClose(c, err)

	for !c.outboundBuffer.IsEmpty() {
		iov, _ := c.outboundBuffer.Peek(0)
		n, err := gio.Writev(c.fd, iov)
		if err != nil {
			break
		}
		_, _ = c.outboundBuffer.Discard(n)
	}

	c.release()
	err0, err1 := el.poller.Delete(c.fd), unix.Close(c.fd)
	if err0 != nil || err1 != nil {
		// 省略错误拼接
	}
	return el.handleAction(c, action)
}
```

这条路径也解释了为什么外部 goroutine 关闭连接时应使用并发安全的 `Close` 或 `CloseWithCallback`。它们会通过 `Trigger` 回到 event-loop，而不是绕过连接表、poller 和用户回调直接关 fd。

## 回到最初的问题

gnet 的核心不是“用了 epoll 所以快”，而是围绕 event-loop 维护了一套清晰的归属规则：连接属于某个 event-loop；非并发安全的读写和状态修改必须在这个 event-loop 内完成；外部 goroutine 如果要写数据、唤醒连接或关闭连接，需要通过 `poller.Trigger` 投递任务；`eventfd` 负责把这些内部任务变成 epoll 可以感知的事件。

放回这个上下文里看，`AsyncWrite`、`Wake`、`Register`、main reactor 向 sub reactor 分发连接，其实都是同一种机制的不同使用场景。它们解决的不是“如何调用一个函数”，而是如何在不破坏 event-loop 状态归属的前提下，让其他 goroutine 安全地参与 I/O 流程。

这也是阅读 gnet 源码时最值得抓住的线索：先看事件从哪里来，再看它在哪个 event-loop 里执行，最后看跨 goroutine 的动作是如何通过队列和 eventfd 回到这个 event-loop 的。沿着这条线，Reactor、poller、连接缓冲和异步写就能串成一个完整的工程设计，而不是一组零散的源码片段。

## 参考资料

- `github.com/panjf2000/gnet/v2`，参考版本 `v2.4.1-93-g0c3e6f82`
- `gnet.go`
- `engine_unix.go`
- `eventloop_unix.go`
- `reactor_default.go`
- `acceptor_unix.go`
- `connection_unix.go`
- `connection_linux.go`
- `pkg/netpoll/poller_epoll_default.go`
