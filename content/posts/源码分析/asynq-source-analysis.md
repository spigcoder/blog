# Asynq 源码分析：从任务创建到 Redis 状态机

异步任务队列的接口通常很简单：业务侧创建一个任务，把它交给 Client；后台启动 Server，从队列里取出任务并交给 Handler 执行。Asynq 也是这个模型，但源码真正值得看的地方不在 API 表面，而在它如何把“提交任务”和“可靠执行”拆成一套 Redis 状态机。

本文以 Asynq `v0.26.0` 源码为参照，围绕三个源码入口展开：

`asynq.go` 负责定义任务的公开抽象；`client.go` 负责把任务写入 Redis，并决定它进入 `pending`、`scheduled` 还是 `aggregating`；`server.go` 和 `processor.go` 负责启动后台组件、消费任务、处理成功和失败后的状态迁移。

定时能力也放在这条主线里看：`ProcessAt/ProcessIn` 是 Client 写入 `scheduled` 状态，之后由 Server 内部的 `forwarder` 转回 `pending`；`Scheduler` 则是一个按 cron 周期调用 Client 入队的任务生产者。这样组织后，Asynq 的源码可以被压缩成一条更清楚的路径：

`Task -> Client -> Redis 状态 -> Server -> Handler -> Done/Retry/Archive`

## 先看源码地图：三个入口分别解决什么问题

读 Asynq 源码时容易被文件数量干扰。仅看主链路，其实可以先抓住三个层次。

`Task` 层只回答“一个业务任务是什么”。它不关心 Redis，也不关心 worker，只描述任务类型、payload、headers 和 options。

`Client` 层回答“任务如何进入队列系统”。它会把公开的 `Task` 转成内部 `TaskMessage`，补齐任务 ID、重试次数、超时、唯一性、队列名等元数据，然后调用 `internal/rdb` 写 Redis。

`Server` 层回答“任务如何被执行并收束状态”。它启动 `processor`、`forwarder`、`recoverer`、`syncer` 等后台协程，其中 `processor` 是消费主干：从 Redis 出队、创建 worker、调用 Handler，然后根据返回值决定 Done、Retry 或 Archive。

后面的源码分析按这个顺序展开。先把任务对象看清楚，再看 Client 如何写入状态，最后看 Server 如何推进状态。

## Task：公开任务对象只保留业务输入

业务侧创建任务时，通常只需要任务类型和 payload：

```go
func NewEmailDeliveryTask(userID int, tmplID string) (*asynq.Task, error) {
    payload, err := json.Marshal(EmailDeliveryPayload{
        UserID:     userID,
        TemplateID: tmplID,
    })
    if err != nil {
        return nil, err
    }
    return asynq.NewTask(TypeEmailDelivery, payload), nil
}
```

对应到源码，公开的 `Task` 结构很克制：

```go
type Task struct {
    typename string
    payload  []byte
    headers  map[string]string
    opts     []Option
    w        *ResultWriter
}

func NewTask(typename string, payload []byte, opts ...Option) *Task {
    return &Task{
        typename: typename,
        payload:  payload,
        headers:  nil,
        opts:     opts,
    }
}
```

这里没有 `state`、`retry count`、`deadline`、`queue` 这类运行时字段。原因很直接：公开 `Task` 是业务输入，不是调度记录。业务代码只负责说明“要做什么”；任务进入队列系统之后，Asynq 才需要维护“现在在哪个状态、还能重试几次、什么时候超时、是否持有 lease”。

内部真正写入 Redis 的是 `base.TaskMessage`。它是在 Client 入队时由 `Task` 转换出来的运行时描述：

```go
type TaskMessage struct {
    Type      string
    Payload   []byte
    ID        string
    Queue     string
    Retry     int
    Retried   int
    ErrorMsg  string
    Timeout   int64
    Deadline  int64
    UniqueKey string
    GroupKey  string
    Retention int64
    ...
}
```

这个分层是理解后面流程的基础：`Task` 面向用户，`TaskMessage` 面向队列状态机。

## Client：任务如何进入队列系统

Client 这一层负责把业务侧创建的 `Task` 写入队列系统。它不是简单调用一次 Redis 写入，而是先把 options 和默认值合并成完整调度策略，再根据任务类型选择不同的初始状态。

### 入队前先把业务任务变成调度记录

`Client.Enqueue` 本身只是把 context 固定为 `context.Background()`，真正逻辑在 `EnqueueContext`：

```go
func (c *Client) Enqueue(task *Task, opts ...Option) (*TaskInfo, error) {
    return c.EnqueueContext(context.Background(), task, opts...)
}
```

`EnqueueContext` 要解决的第一个问题是合并任务默认选项和本次入队选项。比如一个任务在 `NewTask` 时设置了 `MaxRetry(5)`，入队时又传入 `MaxRetry(10)`，最终以后者为准。

```go
func (c *Client) EnqueueContext(ctx context.Context, task *Task, opts ...Option) (*TaskInfo, error) {
    if task == nil {
        return nil, fmt.Errorf("task cannot be nil")
    }
    if strings.TrimSpace(task.Type()) == "" {
        return nil, fmt.Errorf("task typename cannot be empty")
    }

    opts = append(task.opts, opts...)
    opt, err := composeOptions(opts...)
    if err != nil {
        return nil, err
    }
    ...
}
```

`composeOptions` 会补齐默认值：默认队列是 `default`，默认最大重试次数是 `25`，如果既没有设置 timeout 也没有设置 deadline，则默认 timeout 是 `30min`。这些默认值不会暴露在 `Task` 上，而是在进入队列前被写入 `TaskMessage`。

```go
msg := &base.TaskMessage{
    ID:        opt.taskID,
    Type:      task.Type(),
    Payload:   task.Payload(),
    Headers:   maps.Clone(task.Headers()),
    Queue:     opt.queue,
    Retry:     opt.retry,
    Deadline:  deadline.Unix(),
    Timeout:   int64(timeout.Seconds()),
    UniqueKey: uniqueKey,
    GroupKey:  opt.group,
    Retention: int64(opt.retention.Seconds()),
}
```

到这里，Client 已经把一个轻量的业务 `Task` 变成了可调度、可恢复、可重试的 `TaskMessage`。下一步才是决定写入哪个状态。

### 一次入队会分成三条状态路径

Asynq 的任务并不总是直接进入 `pending`。`EnqueueContext` 根据 options 把任务分成三类：

```go
now := time.Now()
var state base.TaskState
if opt.processAt.After(now) {
    err = c.schedule(ctx, msg, opt.processAt, opt.uniqueTTL)
    state = base.TaskStateScheduled
} else if opt.group != "" {
    opt.processAt = time.Time{}
    err = c.addToGroup(ctx, msg, opt.group, opt.uniqueTTL)
    state = base.TaskStateAggregating
} else {
    opt.processAt = now
    err = c.enqueue(ctx, msg, opt.uniqueTTL)
    state = base.TaskStatePending
}
```

这段分支就是 Client 侧最核心的状态选择。

普通任务进入 `pending`，等待 worker 立即消费；设置 `ProcessAt` 或 `ProcessIn` 的任务进入 `scheduled`，等待到期后再转入 `pending`；设置 `Group` 的任务进入 `aggregating`，等待聚合组件把同组任务合成一个新任务。

本文主线先看普通任务和延迟任务，分组聚合只保留这个入口，不展开聚合细节。

### 普通任务写入 pending

普通任务最终会进入 `RDB.Enqueue`。这一步并不是简单 `LPUSH payload`，而是同时写任务详情和 pending list。

```go
func (r *RDB) Enqueue(ctx context.Context, msg *base.TaskMessage) error {
    encoded, err := base.EncodeMessage(msg)
    ...
    keys := []string{
        base.TaskKey(msg.Queue, msg.ID),
        base.PendingKey(msg.Queue),
    }
    argv := []interface{}{
        encoded,
        msg.ID,
        r.clock.Now().UnixNano(),
    }
    n, err := r.runScriptWithErrorCode(ctx, op, enqueueCmd, keys, argv...)
    ...
}
```

对应的 Lua 脚本保留了两个不变量：任务详情写在 `task key`，队列里只存任务 ID。

```lua
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("HSET", KEYS[1],
           "msg", ARGV[1],
           "state", "pending",
           "pending_since", ARGV[3])
redis.call("LPUSH", KEYS[2], ARGV[2])
return 1
```

这样设计的好处是后续状态迁移可以只移动任务 ID，同时保留同一份任务元数据。例如任务从 `pending` 到 `active`、从 `active` 到 `retry`，都不需要复制整个 payload 到不同 list。

### 延迟任务写入 scheduled

一次性定时任务由 `ProcessAt` 或 `ProcessIn` 表达。它不是在客户端等待到指定时间再入队，而是立即写入 Redis 的 `scheduled` zset。score 是任务应该开始具备执行资格的时间。

```go
func (r *RDB) Schedule(ctx context.Context, msg *base.TaskMessage, processAt time.Time) error {
    encoded, err := base.EncodeMessage(msg)
    ...
    keys := []string{
        base.TaskKey(msg.Queue, msg.ID),
        base.ScheduledKey(msg.Queue),
    }
    argv := []interface{}{
        encoded,
        processAt.Unix(),
        msg.ID,
    }
    n, err := r.runScriptWithErrorCode(ctx, op, scheduleCmd, keys, argv...)
    ...
}
```

Lua 脚本同样先写任务详情，再把任务 ID 写入 zset：

```lua
if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
end
redis.call("HSET", KEYS[1],
           "msg", ARGV[1],
           "state", "scheduled")
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
return 1
```

这说明 `scheduled` 不是执行队列，而是等待区。任务只有被转回 `pending` 后，才会被 worker 消费。

### 特殊生产者：Scheduler 周期性产生任务

`ProcessAt/ProcessIn` 解决的是“某条任务未来执行一次”。周期任务是另一类问题：按 cron 表达式不断产生新任务。Asynq 用 `Scheduler` 来做这件事。

`Scheduler` 不是 worker，也不直接执行业务逻辑。它内部持有一个 `cron.Cron`，到点后复用普通 `Client.Enqueue` 创建新任务。

```go
type Scheduler struct {
    id string

    state *serverState

    client *Client
    rdb    *rdb.RDB
    cron   *cron.Cron
    ...

    mu    sync.Mutex
    idmap map[string]cron.EntryID
}
```

注册周期任务时，Asynq 把任务和 options 包装成 `enqueueJob`，再注册到 cron：

```go
func (s *Scheduler) Register(cronspec string, task *Task, opts ...Option) (entryID string, err error) {
    job := &enqueueJob{
        id:       uuid.New(),
        cronspec: cronspec,
        task:     task,
        opts:     opts,
        client:   s.client,
        rdb:      s.rdb,
        ...
    }
    cronID, err := s.cron.AddJob(cronspec, job)
    ...
    s.idmap[job.id.String()] = cronID
    return job.id.String(), nil
}
```

真正到点时，`enqueueJob.Run` 才调用 Client 入队：

```go
func (j *enqueueJob) Run() {
    if j.preEnqueueFunc != nil {
        j.preEnqueueFunc(j.task, j.opts)
    }
    info, err := j.client.Enqueue(j.task, j.opts...)
    if j.postEnqueueFunc != nil {
        j.postEnqueueFunc(info, err)
    }
    if err != nil {
        ...
        return
    }
    event := &base.SchedulerEnqueueEvent{
        TaskID:     info.ID,
        EnqueuedAt: time.Now().In(j.location),
    }
    err = j.rdb.RecordSchedulerEnqueueEvent(j.id.String(), event)
    ...
}
```

所以周期任务的本质不是“Scheduler 执行业务”，而是“Scheduler 周期性生产普通任务”。生产出来的任务仍然走 `Client -> Redis -> Server -> Handler` 这套生命周期，也会受到重试、超时、队列优先级和归档规则影响。

`Scheduler.Start` 也能体现这个定位：它启动 cron，同时通过 heartbeat 把当前 entry 快照写入 Redis，方便观察调度器状态。

```go
func (s *Scheduler) Start() error {
    if err := s.start(); err != nil {
        return err
    }
    s.cron.Start()
    s.wg.Add(1)
    go s.runHeartbeater()
    return nil
}

func (s *Scheduler) beat() {
    var entries []*base.SchedulerEntry
    for _, entry := range s.cron.Entries() {
        job := entry.Job.(*enqueueJob)
        e := &base.SchedulerEntry{
            ID:      job.id.String(),
            Spec:    job.cronspec,
            Type:    job.task.Type(),
            Payload: job.task.Payload(),
            Opts:    stringifyOptions(job.opts),
            Next:    entry.Next,
            Prev:    entry.Prev,
        }
        entries = append(entries, e)
    }
    _ = s.rdb.WriteSchedulerEntries(s.id, entries, s.heartbeatInterval*2)
}
```

这里也有一个边界：Scheduler 只保证按 cron 规则尝试入队，不保证任务执行成功。任务是否成功执行，仍然由 Server 侧的状态机负责。

## Server：任务如何被推进和收束

Server 这一层负责消费和推进任务状态。它的关键不只是启动 worker，而是协调多个后台组件，把 `pending`、`scheduled`、`retry`、`active`、`completed`、`archived` 这些状态连接起来。

### 启动时把不同后台职责拆开

Client 负责生产任务，Server 负责推进任务。`Server.Start` 的关键不是初始化配置，而是启动一组后台组件：

```go
func (srv *Server) Start(handler Handler) error {
    ...
    srv.processor.handler = handler

    if err := srv.start(); err != nil {
        return err
    }

    srv.heartbeater.start(&srv.wg)
    srv.healthchecker.start(&srv.wg)
    srv.subscriber.start(&srv.wg)
    srv.syncer.start(&srv.wg)
    srv.recoverer.start(&srv.wg)
    srv.forwarder.start(&srv.wg)
    srv.processor.start(&srv.wg)
    srv.janitor.start(&srv.wg)
    srv.aggregator.start(&srv.wg)
    return nil
}
```

先不用展开所有组件，只看主链路就够了。

`processor` 负责从 `pending` 取任务并调用 Handler；`forwarder` 负责把到期的 `scheduled/retry` 任务转回 `pending`；`recoverer` 负责处理 lease 过期的 active 任务；`syncer` 用于在部分 Redis 写失败时做补偿重试。

这几个组件围绕同一个状态机工作，不是互相独立的功能点。

### forwarder 把到期任务转回 pending

延迟任务和失败重试任务都不会被 worker 直接消费。它们先位于 zset：一次性延迟任务在 `scheduled`，失败重试任务在 `retry`。Server 启动的 `forwarder` 会周期性扫描这两个 zset。

```go
func (f *forwarder) start(wg *sync.WaitGroup) {
    wg.Add(1)
    go func() {
        defer wg.Done()
        timer := time.NewTimer(f.avgInterval)
        for {
            select {
            case <-f.done:
                return
            case <-timer.C:
                f.exec()
                timer.Reset(f.avgInterval)
            }
        }
    }()
}

func (f *forwarder) exec() {
    if err := f.broker.ForwardIfReady(f.queues...); err != nil {
        f.logger.Errorf("Failed to forward scheduled tasks: %v", err)
    }
}
```

`ForwardIfReady` 会对每个队列检查 `scheduled` 和 `retry`：

```go
func (r *RDB) forwardAll(qname string) (err error) {
    delayedKeys := []string{base.ScheduledKey(qname), base.RetryKey(qname)}
    pendingKey := base.PendingKey(qname)
    taskKeyPrefix := base.TaskKeyPrefix(qname)
    groupKeyPrefix := base.GroupKeyPrefix(qname)
    for _, delayedKey := range delayedKeys {
        n := 1
        for n != 0 {
            n, err = r.forward(delayedKey, pendingKey, taskKeyPrefix, groupKeyPrefix)
            if err != nil {
                return err
            }
        }
    }
    return nil
}
```

Lua 脚本会选出 score 小于当前时间的任务，一次最多移动 100 个，避免脚本运行过久：

```lua
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 100)
for _, id in ipairs(ids) do
    local taskKey = ARGV[2] .. id
    local group = redis.call("HGET", taskKey, "group")
    if group and group ~= '' then
        redis.call("ZADD", ARGV[4] .. group, ARGV[1], id)
        redis.call("ZREM", KEYS[1], id)
        redis.call("HSET", taskKey, "state", "aggregating")
    else
        redis.call("LPUSH", KEYS[2], id)
        redis.call("ZREM", KEYS[1], id)
        redis.call("HSET", taskKey,
                   "state", "pending",
                   "pending_since", ARGV[3])
    end
end
return table.getn(ids)
```

这解释了 Asynq 定时能力的精度边界：`ProcessAt/ProcessIn` 不是强实时定时器，而是“到指定时间后可以被转入 pending”。实际执行还受 forwarder 轮询间隔、Redis 延迟、worker 并发、队列优先级和积压量影响。

### processor 从 pending 获取执行权

`processor.exec` 是消费主干。它先通过信号量控制并发，然后从 broker 出队：

```go
func (p *processor) exec() {
    select {
    case <-p.quit:
        return
    case p.sema <- struct{}{}:
        qnames := p.queues()
        msg, leaseExpirationTime, err := p.broker.Dequeue(qnames...)
        switch {
        case errors.Is(err, errors.ErrNoProcessableTask):
            ...
            <-p.sema
            return
        case err != nil:
            ...
            <-p.sema
            return
        }

        lease := base.NewLease(leaseExpirationTime)
        deadline := p.computeDeadline(msg)
        p.starting <- &workerInfo{msg, time.Now(), deadline, lease}

        go func() {
            defer func() {
                p.finished <- msg
                <-p.sema
            }()
            ...
        }()
    }
}
```

这里的 `sema` 是并发控制点，它对应用户配置的 `Config.Concurrency`。拿不到信号量时，processor 不会继续创建 worker。拿到任务之后，任务会带着 lease 和 deadline 进入 worker goroutine。

Redis 侧的 `Dequeue` 不是单纯从 list 弹出一个 ID。它要完成“获得执行权”：从 `pending` 取任务、写入 `active`、登记 lease，并返回任务消息。

```go
func (r *RDB) Dequeue(qnames ...string) (msg *base.TaskMessage, leaseExpirationTime time.Time, err error) {
    for _, qname := range qnames {
        keys := []string{
            base.PendingKey(qname),
            base.PausedKey(qname),
            base.ActiveKey(qname),
            base.LeaseKey(qname),
        }
        leaseExpirationTime = r.clock.Now().Add(LeaseDuration)
        argv := []interface{}{
            leaseExpirationTime.Unix(),
            base.TaskKeyPrefix(qname),
        }
        res, err := dequeueCmd.Run(context.Background(), r.client, keys, argv...).Result()
        ...
        msg, err = base.DecodeMessage([]byte(encoded))
        return msg, leaseExpirationTime, nil
    }
    return nil, time.Time{}, errors.E(op, errors.NotFound, errors.ErrNoProcessableTask)
}
```

任务进入 `active` 后，即使 worker 崩溃也不会立即丢失。只要 lease 到期，恢复逻辑就能识别并重新调度。这是 Asynq 支持 worker 崩溃恢复的核心基础。

### 多台 Server 如何分布式消费同一个队列

Asynq 被称为分布式任务队列，关键不在于 Server 之间互相通信，而在于它们共享同一个 Redis，并通过 Redis 的原子命令竞争任务处理权。可以把每一台机器上的 `Server` 看成一个独立 worker 进程：它们都运行自己的 `processor`，都监听相同的队列，也都调用同一个 `RDB.Dequeue`。

假设有三台机器同时运行 Server，并且都消费 `default` 队列：

```text
Server A ┐
Server B ├── Dequeue(asynq:{default}:pending) ── Redis
Server C ┘
```

它们不会先通过某个中心节点分配任务，而是直接到 Redis 上抢任务。能保证同一条任务不会同时被两个 Server 拿到的地方，是 `dequeueCmd` 里的原子迁移：

```lua
local id = redis.call("RPOPLPUSH", KEYS[1], KEYS[3])
if id then
    local key = ARGV[2] .. id
    redis.call("HSET", key, "state", "active")
    redis.call("HDEL", key, "pending_since")
    redis.call("ZADD", KEYS[4], ARGV[1], id)
    return redis.call("HGET", key, "msg")
end
```

这里的 `KEYS[1]` 是 pending list，`KEYS[3]` 是 active list。`RPOPLPUSH` 会把一个任务 ID 从 `pending` 原子移动到 `active`。因为这个移动发生在 Redis 内部，多个 Server 同时执行脚本时，也只有一个 Server 能拿到某个具体任务 ID。其他 Server 要么拿到另一个任务，要么拿到 nil。

所以 Asynq 的分布式消费模型可以概括为：

```text
多个 Server 共享 Redis pending 队列
    -> 每个 Server 本地用 sema 控制并发
    -> Redis Lua 原子出队保证任务只被一个 Server 取得处理权
    -> 任务进入 active，并写入 lease
    -> 成功则 Done，失败则 Retry/Archive，崩溃则靠 lease 恢复
```

这里还要区分“每台机器的并发”和“整个集群的并发”。`Config.Concurrency` 是单个 Server 进程内的 worker 数量。如果三台机器都设置 `Concurrency: 10`，理论上整个队列最多会有约 30 个任务同时被处理。Asynq 不需要全局调度器来维护这个总并发；它把每台机器的本地并发控制交给 `processor.sema`，把跨机器的任务归属交给 Redis 原子出队。

分布式系统里真正麻烦的是失败路径。一个 Server 拿到任务后可能在 Handler 执行中崩溃，如果只从 pending 弹出任务，这条任务就丢了。Asynq 的处理方式是出队时立刻把任务放进 `active`，并在 `lease` zset 里写入过期时间：

```lua
redis.call("HSET", key, "state", "active")
redis.call("ZADD", KEYS[4], ARGV[1], id)
```

这意味着“任务正在某个 worker 手里”也被持久化到了 Redis。只要 worker 正常运行，heartbeater 会持续记录进程和 worker 信息；如果进程崩溃，lease 到期后，`recoverer` 就能识别这些卡在 active 的任务，并把它们重新放回可处理路径。也正因为如此，Asynq 提供的是 at-least-once 语义：任务不会轻易丢，但在崩溃恢复边界上可能被再次执行，业务 Handler 需要保持幂等。

### Handler 返回值决定任务如何收束

用户注册的 Handler 看起来只是一个普通函数：

```go
func HandleEmailDeliveryTask(ctx context.Context, t *asynq.Task) error {
    var p EmailDeliveryPayload
    if err := json.Unmarshal(t.Payload(), &p); err != nil {
        return fmt.Errorf("json.Unmarshal failed: %v: %w", err, asynq.SkipRetry)
    }
    ...
    return nil
}
```

processor 会把内部 `TaskMessage` 重新包装成公开 `Task`，然后调用 Handler：

```go
resCh := make(chan error, 1)
go func() {
    task := newTask(
        msg.Type,
        msg.Payload,
        &ResultWriter{
            id:     msg.ID,
            qname:  msg.Queue,
            broker: p.broker,
            ctx:    ctx,
        },
    )
    task.headers = msg.Headers
    resCh <- p.perform(ctx, task)
}()
```

执行结果会进入一个 `select`，这里集中处理几个关键边界：

```go
select {
case <-p.abort:
    p.requeue(lease, msg)
    return
case <-lease.Done():
    cancel()
    p.handleFailedMessage(ctx, lease, msg, ErrLeaseExpired)
    return
case <-ctx.Done():
    p.handleFailedMessage(ctx, lease, msg, ctx.Err())
    return
case resErr := <-resCh:
    if resErr != nil {
        p.handleFailedMessage(ctx, lease, msg, resErr)
        return
    }
    p.handleSucceededMessage(lease, msg)
}
```

`abort` 来自 Server 关闭超时，此时任务会被重新放回队列；lease 过期会被视为失败；context 超时或取消也会进入失败处理；只有 Handler 返回 nil，任务才进入成功路径。

成功路径很短：如果设置了 retention，任务进入 `completed`；否则从 active 中删除。

```go
func (p *processor) handleSucceededMessage(l *base.Lease, msg *base.TaskMessage) {
    if msg.Retention > 0 {
        p.markAsComplete(l, msg)
    } else {
        p.markAsDone(l, msg)
    }
}
```

失败路径则根据错误类型和重试次数决定下一站：

```go
func (p *processor) handleFailedMessage(ctx context.Context, l *base.Lease, msg *base.TaskMessage, err error) {
    if p.errHandler != nil {
        p.errHandler.HandleError(ctx, NewTaskWithHeaders(msg.Type, msg.Payload, msg.Headers), err)
    }
    switch {
    case errors.Is(err, RevokeTask):
        p.markAsDone(l, msg)
    case msg.Retried >= msg.Retry || errors.Is(err, SkipRetry):
        p.archive(l, msg, err)
    default:
        p.retry(l, msg, err, p.isFailureFunc(err))
    }
}
```

`SkipRetry` 的含义就在这里：它不是简单地“不再试一次”，而是绕过 retry 路径，直接进入 archive。`RevokeTask` 更进一步：既不 retry，也不 archive，而是直接 Done。

### Done、Retry、Archive 都是 Redis 原子迁移

任务成功后，`Done` 需要同时完成三件事：从 active list 移除任务 ID，从 lease zset 删除租约，删除任务详情，并更新统计。

```lua
if redis.call("LREM", KEYS[1], 0, ARGV[1]) == 0 then
  return redis.error_reply("NOT FOUND")
end
if redis.call("ZREM", KEYS[2], ARGV[1]) == 0 then
  return redis.error_reply("NOT FOUND")
end
if redis.call("DEL", KEYS[3]) == 0 then
  return redis.error_reply("NOT FOUND")
end
local n = redis.call("INCR", KEYS[4])
...
return redis.status_reply("OK")
```

失败但还能重试时，`Retry` 会更新 `TaskMessage` 的失败信息和重试次数，然后把任务从 active 移到 retry zset：

```go
func (r *RDB) Retry(ctx context.Context, msg *base.TaskMessage, processAt time.Time, errMsg string, isFailure bool) error {
    modified := *msg
    if isFailure {
        modified.Retried++
    }
    modified.ErrorMsg = errMsg
    modified.LastFailedAt = now.Unix()
    encoded, err := base.EncodeMessage(&modified)
    ...
    keys := []string{
        base.TaskKey(msg.Queue, msg.ID),
        base.ActiveKey(msg.Queue),
        base.LeaseKey(msg.Queue),
        base.RetryKey(msg.Queue),
        ...
    }
    argv := []interface{}{
        msg.ID,
        encoded,
        processAt.Unix(),
        ...
    }
    return r.runScript(ctx, op, retryCmd, keys, argv...)
}
```

重试耗尽或显式 `SkipRetry` 时，任务进入 archive。归档不是无限保留，源码中有两个约束：最多保留 `10000` 条，默认归档任务 `90` 天后可清理。

```go
const (
    maxArchiveSize           = 10000
    archivedExpirationInDays = 90
)

func (r *RDB) Archive(ctx context.Context, msg *base.TaskMessage, errMsg string) error {
    modified := *msg
    modified.ErrorMsg = errMsg
    modified.LastFailedAt = now.Unix()
    encoded, err := base.EncodeMessage(&modified)
    ...
    keys := []string{
        base.TaskKey(msg.Queue, msg.ID),
        base.ActiveKey(msg.Queue),
        base.LeaseKey(msg.Queue),
        base.ArchivedKey(msg.Queue),
        ...
    }
    ...
    return r.runScript(ctx, op, archiveCmd, keys, argv...)
}
```

这些状态迁移都使用 Lua，是因为 Redis 中的多个结构必须一起更新。只移动 list 不更新 hash，或者只更新 hash 不删除 lease，都会让系统进入不一致状态。Asynq 的可靠性很大程度上来自这些原子迁移。

## 把三块源码串起来看

整理之后，Asynq 主流程可以按三个源码区域来记。

`asynq.go` 定义任务公开模型。用户创建的是 `Task`，里面只有类型、payload、headers 和 options；真正参与调度的是入队时生成的 `TaskMessage`。

`client.go` 定义任务如何进入系统。它合并 options，生成 `TaskMessage`，根据配置写入 `pending`、`scheduled` 或 `aggregating`。普通任务直接进 pending；延迟任务先进 scheduled；周期任务由 `Scheduler` 周期性调用 Client 入队。

`server.go` 和 `processor.go` 定义任务如何被推进。Server 启动多个后台组件；`forwarder` 把到期任务转回 pending；`processor` 从 pending 获取任务并登记 lease；Handler 返回后，任务进入 Done、Retry 或 Archive。

从这个结构出发，再读 `recoverer`、`syncer`、`heartbeater`、`janitor`、`aggregator` 会顺很多。它们不是新的主线，而是在同一套状态机上补齐恢复、补偿、可观测、清理和聚合这些边界能力。

Asynq 的核心并不是“用 Go 起几个 worker goroutine”这么简单，而是把一个任务拆成公开输入、内部元数据和 Redis 状态迁移三层。理解这一点后，`Client`、`Server` 和定时调度这些看似分散的源码，就能回到同一张图里。
