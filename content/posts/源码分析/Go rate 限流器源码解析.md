---
title: "Go rate 限流器源码解析"
tags: ["Go", "源码分析", "限流", "令牌桶", "并发"]
excerpt: "从 golang.org/x/time/rate 的 Limiter 实现出发，理解令牌桶如何处理立即放行、未来预约、阻塞等待、取消归还和动态调参。"
---

# Go rate 限流器源码解析

限流通常不是为了让系统“少处理一点请求”，而是为了把突发流量约束在下游可以承受的范围内。请求到达速度一旦超过处理速度，压力最终会落到数据库、远程服务、CPU、内存或连接池上。限流器做的事情，就是在请求进入真正的处理逻辑之前，先回答一个问题：现在能不能执行，如果不能，是直接拒绝，还是等一会儿再执行。

常见限流算法有几类。固定窗口计数器按时间窗口统计请求数，实现简单，但窗口边界附近可能放过两倍流量；滑动窗口把统计粒度切得更细，边界更平滑，代价是维护成本更高；漏桶把请求按固定速率流出，适合削平流量，但对突发请求不够友好；令牌桶则按固定速率生成令牌，请求执行前先消耗令牌，桶容量允许一定突发，长期看又能把平均速率限制住。

Go 官方扩展包 `golang.org/x/time/rate` 使用的就是令牌桶模型。它的公开类型是 `Limiter`，既可以用于“没有令牌就拒绝”的场景，也可以用于“没有令牌就排队等待”的场景。真正进入源码后会发现，这个实现的重点不只是从桶里扣掉令牌，而是如何把立即放行、未来预约、阻塞等待、取消等待和动态修改速率都放进同一套状态模型里。

本文以 Go 官方扩展包 `golang.org/x/time/rate` 的 `rate.go` 为参照，聚焦 `Limiter`、`Reservation`、`reserveN`、`WaitN` 和 `CancelAt` 这条主线。后文只展示核心片段，重点放在状态如何流动，以及这些状态维护了哪些边界。

## 从使用入口看问题

`Limiter` 对外暴露的三个主入口是 `Allow`、`Reserve` 和 `Wait`。它们都消耗令牌，但处理缺令牌的方式不同：`Allow` 只判断当前能不能过，不能过就返回 `false`；`Reserve` 会把未来的令牌提前预约出来，并告诉调用方需要等多久；`Wait` 则把预约和等待封装起来，直到令牌可用或者 `context` 取消。

这个差异决定了源码不能只维护“当前令牌数”。如果系统允许预约未来的令牌，那么令牌数可能短暂变成负数，表示已经把未来一段时间的容量借出去了；如果等待过程被取消，还要尽可能把这次预约造成的影响归还回去；如果此时后面还有其他预约，又不能把别人的位置一起撤掉。

这就是 `rate.go` 里几个字段存在的原因：

```go
type Limiter struct {
	mu     sync.Mutex
	limit  Limit
	burst  int
	tokens float64
	last time.Time
	lastEvent time.Time
}
```

`limit` 表示每秒生成多少令牌，`burst` 表示桶容量上限，`tokens` 表示当前可用令牌数。`last` 是上次计算令牌数的时间，`lastEvent` 则更特殊：它记录最近一次被限流器允许的事件时间，这个时间可以在未来。理解 `lastEvent`，基本就抓住了 `Reserve` 和 `Cancel` 的关键。

## 令牌不会自己增长

很多限流器实现不会启动后台 goroutine 定时往桶里放令牌，`rate.Limiter` 也是这样。它采用惰性计算：每次调用时，根据当前时间和 `last` 的差值，临时算出应该补充多少令牌。

```go
func (lim *Limiter) advance(t time.Time) (newTokens float64) {
	last := lim.last
	if t.Before(last) {
		last = t
	}

	elapsed := t.Sub(last)
	delta := lim.limit.tokensFromDuration(elapsed)
	tokens := lim.tokens + delta
	if burst := float64(lim.burst); tokens > burst {
		tokens = burst
	}
	return tokens
}
```

`advance` 只计算，不修改 `lim` 本身。调用方拿到计算结果后，再决定是否更新 `last` 和 `tokens`。这让 `TokensAt` 这样的查询接口可以复用同一套计算逻辑，又不改变限流器状态。

这里还有一个细节：如果传入时间早于 `last`，源码把 `last` 临时改成传入时间。测试里有 `TestLimiterJumpBackwards` 和 `TestReserveJumpBack`，说明实现明确考虑了时间回拨或测试中手动传入旧时间的场景。它不会让“负时间差”凭空扣掉令牌，而是尽量保持状态计算稳定。

令牌和时间之间的转换由两个小函数完成：

```go
func (limit Limit) durationFromTokens(tokens float64) time.Duration {
	if limit <= 0 {
		return InfDuration
	}
	duration := (tokens / float64(limit)) * float64(time.Second)
	if duration > float64(math.MaxInt64) {
		return InfDuration
	}
	return time.Duration(duration)
}

func (limit Limit) tokensFromDuration(d time.Duration) float64 {
	if limit <= 0 {
		return 0
	}
	return d.Seconds() * float64(limit)
}
```

一个把“欠多少令牌”换算成“需要等多久”，另一个把“经过多久”换算成“生成多少令牌”。这两个函数让后面的逻辑可以围绕 `tokens` 做状态变化，而不是到处散落时间计算。

## reserveN 是真正的核心

`AllowN`、`ReserveN`、`WaitN` 最终都会进入 `reserveN`，区别只在于允许等待多久：

```go
func (lim *Limiter) AllowN(t time.Time, n int) bool {
	return lim.reserveN(t, n, 0).ok
}

func (lim *Limiter) ReserveN(t time.Time, n int) *Reservation {
	r := lim.reserveN(t, n, InfDuration)
	return &r
}
```

`AllowN` 的 `maxFutureReserve` 是 `0`，表示不能预约未来令牌；`ReserveN` 的等待上限是 `InfDuration`，表示只要请求数量不超过 `burst`，就可以排到未来。`WaitN` 会根据 `context deadline` 算出一个最大等待时间，再交给同一个函数判断是否能等到。

核心逻辑集中在这里：

```go
func (lim *Limiter) reserveN(t time.Time, n int, maxFutureReserve time.Duration) Reservation {
	lim.mu.Lock()
	defer lim.mu.Unlock()

	if lim.limit == Inf {
		return Reservation{ok: true, lim: lim, tokens: n, timeToAct: t}
	}

	tokens := lim.advance(t)
	tokens -= float64(n)

	var waitDuration time.Duration
	if tokens < 0 {
		waitDuration = lim.limit.durationFromTokens(-tokens)
	}

	ok := n <= lim.burst && waitDuration <= maxFutureReserve

	r := Reservation{ok: ok, lim: lim, limit: lim.limit}
	if ok {
		r.tokens = n
		r.timeToAct = t.Add(waitDuration)
		lim.last = t
		lim.tokens = tokens
		lim.lastEvent = r.timeToAct
	}
	return r
}
```

这段代码做了几件事。先惰性补充令牌，再扣掉本次请求需要的 `n` 个令牌。如果扣完以后 `tokens` 仍然大于等于零，说明可以立即执行；如果小于零，负数部分就是向未来借出的令牌，再通过 `durationFromTokens` 算出需要等待多久。

判断是否成功也不是只看令牌够不够，而是同时看两个条件：请求数量不能超过 `burst`，等待时长不能超过调用方给出的 `maxFutureReserve`。所以 `AllowN` 在令牌不足时会失败，`ReserveN` 可以成功并返回未来时间，`WaitN` 则会受 `context deadline` 约束。

更关键的是，成功预约后 `lim.tokens` 可以被更新为负数。这个负数不是 bug，而是队列化语义的核心。它表示已经有请求占用了未来生成的令牌，因此后续请求要排在这个预约之后。

## Reservation 保存的是一次未来承诺

`ReserveN` 返回的不是简单的等待时长，而是一个 `Reservation`：

```go
type Reservation struct {
	ok        bool
	lim       *Limiter
	tokens    int
	timeToAct time.Time
	limit Limit
}
```

`timeToAct` 表示这次预约允许执行的时间。`limit` 保存的是预约发生时的速率，而不是之后从 `Limiter` 里再读一次。这一点服务于取消逻辑：如果预约之后调用了 `SetLimit`，取消这笔旧预约时仍然需要按它当时使用的速率计算影响范围。

`DelayFrom` 只是把 `timeToAct` 转成调用方还需要等待的时间：

```go
func (r *Reservation) DelayFrom(t time.Time) time.Duration {
	if !r.ok {
		return InfDuration
	}
	delay := r.timeToAct.Sub(t)
	if delay < 0 {
		return 0
	}
	return delay
}
```

这也解释了为什么 `Reserve` 适合调用方自己控制等待行为。它只是给出“什么时候可以做”，并不负责阻塞当前 goroutine。

## Wait 是预约语义上的阻塞封装

`WaitN` 没有重新实现限流算法，而是在 `reserveN` 外面加了 `context` 和定时器：

```go
func (lim *Limiter) wait(ctx context.Context, n int, t time.Time, newTimer func(d time.Duration) (<-chan time.Time, func() bool, func())) error {
	lim.mu.Lock()
	burst := lim.burst
	limit := lim.limit
	lim.mu.Unlock()

	if n > burst && limit != Inf {
		return fmt.Errorf("rate: Wait(n=%d) exceeds limiter's burst %d", n, burst)
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	waitLimit := InfDuration
	if deadline, ok := ctx.Deadline(); ok {
		waitLimit = deadline.Sub(t)
	}

	r := lim.reserveN(t, n, waitLimit)
	if !r.ok {
		return fmt.Errorf("rate: Wait(n=%d) would exceed context deadline", n)
	}

	delay := r.DelayFrom(t)
	if delay == 0 {
		return nil
	}
	ch, stop, advance := newTimer(delay)
	defer stop()
	advance()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		r.Cancel()
		return ctx.Err()
	}
}
```

流程是清楚的：先排除永远不可能满足的请求，例如 `n > burst`；再检查 `context` 是否已经取消；如果有 deadline，就把 deadline 转成最大可接受等待时间；然后做一次预约。如果预约成功但需要等待，就启动定时器。

取消路径是这里最重要的边界。`WaitN` 已经通过 `reserveN` 改写了限流器状态，如果等待过程中 `context` 取消，不能只是返回错误，还要调用 `r.Cancel()`。否则这次已经放弃的等待会继续占着未来令牌，让后续请求无故变慢。

测试里的 `TestWaitCancel` 正是在验证这一点：等待被取消后，令牌应当被归还，后续请求可以更早通过。

## 取消预约为什么不能简单加回 tokens

`CancelAt` 是这份源码里最容易被低估的部分。直觉上，取消一次预约似乎只要把 `r.tokens` 加回 `lim.tokens`。但只要存在多个未来预约，这么做就会出错。

考虑一个限流器已经有三笔预约：A 在 `t3` 执行，B 在 `t4` 执行，C 在 `t5` 执行。如果后来取消 A，不能把 A 的全部令牌都还回当前时间，因为 B 和 C 已经排在 A 后面，占用了 A 之后那段时间自然生成的令牌。源码用 `lastEvent` 来表示当前排队链条的末端，并据此计算本次取消最多能恢复多少令牌。

```go
restoreTokens := float64(r.tokens) - r.limit.tokensFromDuration(r.lim.lastEvent.Sub(r.timeToAct))
if restoreTokens <= 0 {
	return
}

tokens := r.lim.advance(t)
tokens += restoreTokens
if burst := float64(r.lim.burst); tokens > burst {
	tokens = burst
}

r.lim.last = t
r.lim.tokens = tokens
```

`r.lim.lastEvent.Sub(r.timeToAct)` 表示从这笔预约的执行时间到当前最后一个预约事件之间，系统按当时速率还能生成多少令牌。这部分容量可能已经被后续预约消耗了，所以不能归还。`restoreTokens` 小于等于零时，说明取消这笔预约已经不能给当前队列释放出有效容量。

还有一段用于回退 `lastEvent`：

```go
if r.timeToAct.Equal(r.lim.lastEvent) {
	prevEvent := r.timeToAct.Add(r.limit.durationFromTokens(float64(-r.tokens)))
	if !prevEvent.Before(t) {
		r.lim.lastEvent = prevEvent
	}
}
```

只有被取消的预约正好是队尾时，`lastEvent` 才有机会向前回退。这里仍然要检查 `prevEvent` 不早于当前取消时间，避免把最近事件时间回退到已经过去的位置。

这也是源码分析里值得关注测试用例的原因。`TestCancel0Tokens`、`TestCancel1Token`、`TestCancelMulti` 分别覆盖了取消后不能恢复、只能恢复一部分、多个预约交错取消的场景。主干逻辑看起来简单，真正保证行为正确的是这些边界。

## 动态修改速率只影响之后的计算

`Limiter` 支持运行时修改 `limit` 和 `burst`：

```go
func (lim *Limiter) SetLimitAt(t time.Time, newLimit Limit) {
	lim.mu.Lock()
	defer lim.mu.Unlock()

	tokens := lim.advance(t)
	lim.last = t
	lim.tokens = tokens
	lim.limit = newLimit
}

func (lim *Limiter) SetBurstAt(t time.Time, newBurst int) {
	lim.mu.Lock()
	defer lim.mu.Unlock()

	tokens := lim.advance(t)
	lim.last = t
	lim.tokens = tokens
	lim.burst = newBurst
}
```

这两个方法都有同一个动作：先用旧配置把时间推进到 `t`，再写入新配置。这样做可以避免把过去的一段时间按新速率重新计算。配置变更从调用时间点开始生效，之前已经发生的令牌积累仍然按旧速率结算。

源码注释也提醒了一个边界：调用 `SetLimitAt` 或 `SetBurstAt` 之前已经通过 `Reserve` 或 `Wait` 预约但尚未执行的操作，可能会违反或未充分利用新的配置。换句话说，动态调参不会重新排布已有预约队列。这个取舍让实现保持简单，也避免了修改配置时大规模重写等待中的请求状态。

## 并发安全靠一把锁收束状态

`Limiter` 的公开注释说明它可以被多个 goroutine 安全使用。实现方式并不复杂：所有会读写共享状态的路径都围绕 `mu` 展开。`Limit`、`Burst`、`TokensAt` 这些读方法也会加锁；`reserveN`、`CancelAt`、`SetLimitAt`、`SetBurstAt` 则在锁内完成状态转换。

这份源码没有引入无锁结构，也没有把等待队列显式建成链表。预约队列的效果来自 `tokens` 的负数债务和 `lastEvent` 的未来时间。这样设计的好处是状态很少：一个互斥锁、一组数值字段，就能表达立即放行、未来排队和取消归还。代价是取消逻辑必须非常谨慎，因为它需要从这些压缩状态里推导出“还能归还多少影响”。

## 几个容易误解的边界

`Limit(0)` 并不等于所有请求都永远失败。通过 `NewLimiter(0, 1)` 创建时，初始 `tokens` 等于 `burst`，所以第一次请求可以通过；之后因为速率为零，不会再补充令牌。相反，`Limiter` 的零值是 `limit=0`、`burst=0`、`tokens=0`，它会拒绝所有事件。

`Inf` 是一个特殊速率，表示无限放行。`reserveN` 遇到 `lim.limit == Inf` 会直接返回成功，`WaitN` 也不会因为 `burst` 为零而拒绝超过突发量的请求。

`burst` 限制的是单次最多可消费多少令牌。即使愿意等待很久，`n > burst` 的请求在非 `Inf` 模式下也不会成功。这是令牌桶模型本身的边界：速率限制控制长期平均速度，`burst` 控制瞬时峰值上限。

## 回到 rate 的设计

把 `rate.go` 放回整体看，它并不是用复杂结构实现一个复杂限流器，而是用很少的状态表达了足够多的语义。`advance` 负责把时间变成令牌；`reserveN` 负责把请求变成一次当前或未来的承诺；`Reservation` 负责把承诺暴露给调用方；`WaitN` 在承诺之上增加阻塞和取消；`CancelAt` 则尽可能撤销已经放弃的未来影响。

理解这一点后，再看 `Allow`、`Reserve` 和 `Wait` 的差异就不只是 API 选择问题了。它们分别对应三种业务态度：超限就丢弃、超限但愿意排队、超限时阻塞等待并接受取消。`rate.Limiter` 的源码价值，也正是在同一个令牌桶模型里把这三种态度稳定地统一起来。

## 参考资料

- `golang.org/x/time/rate/rate.go`
- `golang.org/x/time/rate/rate_test.go`
