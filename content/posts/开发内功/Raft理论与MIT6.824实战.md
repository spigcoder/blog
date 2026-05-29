---
title: "Raft 理论与 MIT 6.824 实战"
tags: ["Raft", "分布式系统", "MIT 6.824", "共识算法", "Go"]
excerpt: "从复制状态机、Leader 选举、日志复制和安全性约束出发，结合 MIT 6.824 Raft 实验理解一个可运行实现背后的关键细节。"
---

# Raft 理论与 MIT 6.824 实战

在分布式系统中，很多问题并不来自单个节点的业务逻辑，而是来自多个节点对“同一批操作应该按什么顺序发生”这件事无法形成一致判断。故障、重试、网络延迟和分区都会放大这种不确定性：只要操作顺序不同，即使每台机器执行的代码完全正确，最终状态也可能发生分叉。

而 Raft 解决的就是这个问题。它把客户端请求组织成一条复制日志，要求多个副本以相同顺序提交并应用这些日志项。只要状态机是确定性的，所有副本从同一个初始状态出发，按同一顺序执行同一批命令，就会得到相同结果。

Raft 论文的一个重要设计目标是“可理解性”。它没有把共识过程设计成多个角色对称地互相协商，而是强制所有日志写入都经过 Leader，再由 Leader 复制给 Follower。这个强 Leader 模型牺牲了一些对称性，但显著降低了实现复杂度：选举负责产生唯一 Leader；日志复制负责让多数派保存相同前缀；安全性规则负责保证已经提交的日志不会被后续 Leader 覆盖。

## 共识问题落到工程里是什么

从业务视角看，一个 Raft 集群对外提供的不是“多台机器”，而是一台可靠的状态机。客户端提交命令，例如 `Put(x, 3)` 或 `Append(k, v)`；Raft 负责决定这条命令在全局日志里的位置；当日志项被提交后，每个副本再把它交给上层状态机执行。

MIT 6.5840，也就是原来的 MIT 6.824，在 Raft Lab 里把这个抽象落成了几个接口：

```go
rf := Make(peers, me, persister, applyCh)
rf.Start(command interface{}) (index, term, isLeader)
rf.GetState() (term, isLeader)
```

`Start` 是服务层进入 Raft 的入口。服务层不直接把命令写进本地状态机，而是请求当前 Leader 把命令追加到复制日志中。等这条日志被多数派确认并提交后，Raft 再通过 `applyCh` 发出 `ApplyMsg`，服务层才能真正执行命令。

这个接口边界很关键。Raft 不理解命令的业务含义，它只保证命令序列的一致性；上层 KV 服务不参与共识细节，它只按 Raft 给出的提交顺序应用命令。复制状态机的稳定性，正来自这两个层次之间的清晰分工。

后文涉及具体函数、常量和代码片段时，默认以一个简化的 MIT 6.824 Go 实现实例作为参照。它不是 Raft 的唯一写法，但适合用来把论文里的规则落到选举定时器、RPC 处理、日志下标、提交推进和 `applyCh` 这些工程细节上。

这里还要补一层理解：Raft 不是直接复制状态机结果，而是先复制预写日志。预写日志可以看作写请求进入状态机之前的缓冲区，它把“多个节点如何得到相同状态”转化成了一个更容易约束的问题：多个节点在已提交日志前缀上的内容和顺序必须一致。只要这个前缀一致，状态机再按顺序应用日志，最终状态就会一致。

这也是为什么 Raft 的工程实现里会反复出现 `commitIndex` 和 `lastApplied`。前者表示日志层已经达成共识的位置，后者表示状态机已经执行到的位置。日志被提交，并不等于已经被业务状态机执行；这两个阶段分开后，系统才有机会在复制、持久化、应用之间建立清晰的恢复边界。

## Term：Raft 里的逻辑时间

Raft 用 `term` 表示逻辑时间。每次选举都会进入一个新的 term，RPC 中也都会携带 term。节点一旦看到更大的 term，就必须承认自己过期，转为 Follower。

在实现里，这通常表现为三条规则。收到 `RequestVote` 或 `AppendEntries` 时，如果对方 term 小于自己的 `currentTerm`，直接拒绝；如果对方 term 更大，更新本地 `currentTerm`，清空 `votedFor`，退回 Follower；处理异步 RPC 回复时，还要确认回复对应的 term 仍然是自己当前 term，否则丢弃这个过期回复。

在这个实验实现中，`callRequestVote` 和 `callAppendEntries` 会保存发出 RPC 时的 `term`，收到回复后再比较 `term != rf.currentTerm`。这类检查看起来像防御式编程，实际是 Raft 实现里非常核心的并发边界：RPC 是异步返回的，网络可能延迟，Leader 可能已经退位，如果不丢弃旧 term 的回复，就可能用过期信息更新当前任期的状态。

## Leader 选举：多数派与随机超时

Raft 中的节点只有三种角色：Follower、Candidate、Leader。正常情况下，Follower 接收 Leader 的心跳；如果一段时间没有收到心跳，Follower 就会变成 Candidate，递增 term，给自己投票，并向其他节点发送 `RequestVote`。

一个 Candidate 成为 Leader 的条件是拿到多数派投票。多数派的作用不是“人数更多所以更可信”，而是保证任意两个多数派之间必然有交集。只要一个 term 内每个节点最多投一票，同一个 term 就不可能出现两个都拿到多数派的 Leader。

随机选举超时用于减少多个节点同时发起选举的概率。论文中给出的典型选举超时是 150 到 300ms。

`RequestVote` 不是只看 term。Candidate 还必须证明自己的日志至少和投票者一样新。比较规则是先看最后一条日志的 term，term 更大者更新；term 相同再比较最后日志索引。这个限制对应论文中的 Leader Completeness：一个已经提交的日志项必须出现在后续 Leader 的日志中。否则，一个日志落后的节点可能当选 Leader，并覆盖已经提交过的日志。

## 日志复制：AppendEntries 不只是心跳

`AppendEntries` 是 Raft 里最重要的 RPC。它有两个用途：没有日志项时，它是心跳；带有日志项时，它是复制请求。Leader 会为每个 Follower 维护两个索引：

`nextIndex[i]` 表示下一次要发送给 Follower `i` 的日志位置；`matchIndex[i]` 表示 Leader 已知 Follower `i` 已经复制成功的最高日志位置。

一次日志复制不是简单地把新条目发过去。Leader 会同时带上 `PrevLogIndex` 和 `PrevLogTerm`，要求 Follower 检查自己的日志中是否存在这个前驱项。只有前驱项匹配，Follower 才能追加后续日志。这个检查把日志一致性变成了一个递归保证：只要某个位置的 index 和 term 匹配，那么这个位置之前的日志前缀也应该一致。

Follower 收到 `AppendEntries` 后，核心逻辑可以拆成三步：先拒绝过期 term；再检查 `PrevLogIndex/PrevLogTerm` 是否匹配；如果匹配，则删除本地冲突日志，并追加 Leader 发来的新日志。MIT 6.824 的实现通常也会按这个路径组织：前驱不匹配就返回失败；匹配后从 `PrevLogIndex + 1` 开始比较新旧日志，遇到 term 冲突就截断并追加。

Leader 收到失败回复后，需要回退对应 Follower 的 `nextIndex` 并重试。最朴素的做法是每次减一，实验实现直接采用了这种策略：

```go
rf.nextIndex[server] = int(math.Max(1.0, float64(rf.nextIndex[server]-1)))
```

这个版本容易理解，也足以说明机制，但在大量冲突日志下会比较慢。MIT Lab 后续提示会建议在失败回复中携带冲突 term、冲突 term 的首个 index、日志长度等信息，让 Leader 一次跳过一整段冲突日志。这不是 Raft 安全性的必要条件，而是工程性能优化。

## 提交规则：多数派复制不等于立即可应用

Leader 追加日志后，会把日志复制给 Follower。当某个日志项已经存储在多数派节点上时，它具备提交条件。但 Raft 还有一个容易遗漏的限制：Leader 只能通过多数派复制直接提交当前 term 的日志项。旧 term 的日志项可以随着当前 term 的日志项一起被间接提交，但不能单独依靠多数派数量来推进。

这个限制是为了避免旧 Leader 留下的日志在复杂分区和重新选举后破坏安全性。对应到代码里，`commitChecker` 一类逻辑通常会包含这个判断：

```go
if consensus*2 > len(rf.peers) && rf.log[N].Term == rf.currentTerm {
    rf.commitIndex = N
    rf.cond.Broadcast()
}
```

`commitIndex` 表示已经提交的最高日志位置，`lastApplied` 表示已经交给状态机执行的最高日志位置。两者必须分开：日志被提交意味着 Raft 层已经达成共识；日志被应用意味着服务层已经执行命令。后台 goroutine 可以等待 `commitIndex` 推进，然后按顺序把 `[lastApplied+1, commitIndex]` 之间的日志发送到 `applyCh`。

这个顺序不能乱。即使 index 10 先被确认，也不能越过 index 9 先应用，因为状态机复制依赖的是相同顺序，而不是单条命令独立成功。

工程实现里还经常会在 Leader 刚当选后追加一条 no-op 日志。它没有业务命令，但它属于当前 term。一旦这条 no-op 被多数派复制并提交，Leader 就确认当前 term 已经写入多数派；随后旧 term 的日志也可以随着这条当前 term 日志一起被安全推进。没有这个动作，Leader 可能已经当选，却还不能仅凭多数派复制去提交旧 term 遗留日志。

## 为什么旧 Leader 重新加入不会破坏一致性

Raft 最值得反复推演的场景，是网络分区后的旧 Leader 回归。

假设 5 个节点中，Leader A 只和一个 Follower 留在少数派分区。A 仍然以为自己是 Leader，也可能继续接受客户端请求并写入本地日志，但它无法拿到多数派，因此这些日志不能提交。另一侧 3 个节点会选出新 Leader B，并提交新的日志。等网络恢复后，A 会收到更高 term 的 `AppendEntries`，退回 Follower。随后，B 会用 `PrevLogIndex/PrevLogTerm` 检查 A 的日志，把 A 少数派期间产生的未提交冲突日志截断掉。

这也是 MIT 6.824 测试里 `TestRejoin2B`、`TestBackup2B` 这类用例的意义。它们不是只测“能不能选主”，而是在验证一个更深的性质：未提交日志可以被覆盖，已提交日志不能被覆盖；落后的旧 Leader 回来后，必须被当前多数派日志重新校准。

从实现角度看，相关细节分散在多个地方：`RequestVote` 的日志新旧比较阻止日志落后的节点当选；`AppendEntries` 的前驱匹配和冲突截断负责修复 Follower 日志；`commitChecker` 的当前 term 限制避免错误提交旧 term 日志；RPC 回复里的 term 检查负责让过期 Leader 及时退位。

这些规则单独看都不复杂，但少掉任何一条，Raft 在普通路径上可能仍然工作，在分区、重试和崩溃恢复组合起来时就会出错。

## 持久化：崩溃后不能忘记自己说过什么

Raft 的论文 Figure 2 把状态分成三类：所有服务器上的持久化状态、所有服务器上的易失状态、Leader 上的易失状态。

必须持久化的是 `currentTerm`、`votedFor` 和 `log`。原因很直接：节点重启后不能忘记当前任期，也不能在同一个 term 内重复投票，更不能丢失已经接受过的日志。否则，Raft 的选举安全性和日志安全性都会失效。

`commitIndex` 和 `lastApplied` 通常是易失的，因为重启后可以通过 Leader 的提交信息和日志重新推进；`nextIndex`、`matchIndex` 只对当前 Leader 有意义，每次当选 Leader 后重新初始化即可。

在这个实验实现中，`persist()` 和 `readPersist()` 仍然保留 skeleton 的空实现，因此它更接近 2A/2B 阶段：已经覆盖了选举和日志复制的主要机制，但还没有完成 2C 的崩溃恢复。真正补上持久化时，需要在所有修改 `currentTerm`、`votedFor`、`log` 的路径后调用 `persist()`，包括投票、发现更高 term、Leader 追加日志、Follower 接收并截断/追加日志等位置。

持久化还有一个工程边界：不能只在“看起来重要”的地方保存。Raft 的安全性依赖的是每次状态变更后的稳定记录，而不是进程正常运行时的内存状态。

## 快照：日志不能无限增长

如果系统长期运行，Raft 日志会无限增长。重启时从头回放所有日志也不现实。因此实际系统会引入快照：上层状态机把某个 index 之前的状态压缩成快照，Raft 可以丢弃这个 index 之前的日志。

MIT 6.5840 Lab 3D 就要求实现 `Snapshot(index int, snapshot []byte)` 和 `InstallSnapshot` RPC。当某个 Follower 落后太多，而 Leader 已经丢弃它需要的旧日志时，Leader 不能继续用普通 `AppendEntries` 追日志，只能发送快照让它追上。

快照不是对 Raft 语义的替代。它只是日志压缩手段，仍然必须维护日志索引、快照最后一条日志的 term、提交位置和应用位置之间的关系。很多实现错误都发生在这里：数组下标变成了相对下标，而 Raft 协议里的 log index 仍然是全局递增的逻辑 index。

## etcd 如何把 Raft 工程化

MIT 6.824 的实验实现通常把 Raft、RPC、持久化和 `applyCh` 都放在一个相对紧凑的结构里，适合学习协议本身。etcd 的实现则更接近真实工程：它把 Raft 共识逻辑做成算法层，把网络通信、WAL 持久化、快照和业务状态机交给应用层。

这个拆分的关键接口是 `Node`。应用层通过 `Tick` 驱动 Raft 内部计时，通过 `Propose` 提交写请求，通过 `Step` 把网络收到的 Raft 消息送回算法层，通过 `Ready` 接收算法层产生的结果，再在处理完持久化、发送消息和应用提交日志后调用 `Advance`。这形成了一个稳定循环：

```text
Propose / Step / Tick -> Raft 算法层 -> Ready -> 持久化 / 发送消息 / 应用日志 -> Advance
```

这个模型的好处是边界很清楚。Raft 算法层只决定“应该产生哪些日志、哪些日志已提交、哪些消息需要发送”；应用层负责“如何落盘、如何发网络包、如何把已提交日志作用到 KV 状态机”。因此 etcd 的 `Ready` 里会同时包含几类信息：需要持久化的 `Entries`，需要应用到状态机的 `CommittedEntries`，需要发给其他节点的 `Messages`，以及需要持久化的 `HardState`。

etcd 的 `raftLog` 也把日志状态拆得更细：`unstable` 保存尚未持久化的日志和快照，`storage` 是持久化日志的查询接口，`committed` 表示已提交位置，`applied` 表示已应用位置。这个结构和 MIT 6.824 里的 `log`、`commitIndex`、`lastApplied` 是同一套语义，只是工程化后把内存态、持久化态和应用态分离得更明确。

Leader 侧的 `Progress` 则对应 MIT 实现里的 `nextIndex` 和 `matchIndex`。每个 Follower 都有自己的复制进度，Leader 根据这些进度判断多数派复制是否成立，并据此推进 commit。真实系统还会在这个基础上处理流控、批量发送、快照补齐、ReadIndex 等能力，这些都不是 Raft 安全性的核心规则，但决定了实现能否稳定支撑生产负载。

## 从 MIT 6.824 实现看常见坑

Raft 难不在概念数量，而在状态交错。一个实现是否可靠，往往取决于几个边界是否处理得足够严格。

锁的边界要清楚。访问 `currentTerm`、`state`、`log`、`commitIndex`、`nextIndex`、`matchIndex` 时需要保护；但发送 RPC 和向 `applyCh` 写入时不能长时间持锁，否则容易阻塞其他状态推进。比如在 `applyCommited` 中先取出 `command`，释放锁后再发送 `ApplyMsg`，就是一个合理的方向。

过期 RPC 回复必须丢弃。Raft 中很多 RPC 是 goroutine 并发发出的，回复回来时，节点可能已经进入新 term，甚至从 Leader 退回 Follower。用发送时保存的 term 和当前 `currentTerm` 比较，是避免旧回复污染新状态的必要手段。

日志下标要有统一模型。论文中的日志从 1 开始，MIT Lab 通常建议在实现中放一个 index 0 的 dummy entry。这个实验实现里的 `rf.log = append(rf.log, LogEntry{Term: 0})` 就是在建立这个哨兵项，这样第一次 `PrevLogIndex = 0` 是合法的。后续如果加快照，需要继续维持“协议 index”和“数组 offset”的映射关系，否则 off-by-one 会非常隐蔽。

提交和应用不能混在一起。Leader 推进 `commitIndex`，Follower 根据 `LeaderCommit` 推进自己的 `commitIndex`，后台 apply 逻辑再按顺序推进 `lastApplied`。把这三件事拆开后，代码更啰嗦，但状态会清晰很多。

随机超时不能被固定化。每个节点如果使用相同超时，很容易反复同时发起选举，导致 split vote。实际实现要确保不同节点的 election timeout 分散。用 `rand.New(rand.NewSource(int64(rf.me)))` 为不同节点创建随机源，在实验里可以形成可复现但彼此不同的超时序列。

很多 Raft 理论文章会把重点放在 Leader 选举、日志复制和安全性证明上，而实战文章通常会把篇幅放在 goroutine、锁、RPC 重试、测试用例和日志下标处理上。真正写 MIT 6.824 时，这两类材料最好放在一起读：论文 Figure 2 给出协议边界，实验代码负责暴露并发和故障场景中的细节。尤其是 `TestRejoin`、`TestBackup`、持久化和快照相关测试，它们经常不是在验证某个单独函数，而是在验证多个规则组合后是否仍然保持 Raft 的不变量。

## Raft 的边界

Raft 解决的是非拜占庭故障下的共识问题。它假设节点可能崩溃、重启、网络延迟、消息丢失、消息乱序，但不处理恶意节点伪造消息、篡改协议或联合欺骗多数派。换句话说，Raft 是 crash fault tolerant，不是 Byzantine fault tolerant。

Raft 也不自动提供业务层的 exactly-once 语义。客户端请求可能因为超时重试而被提交多次。真正的 KV 服务通常还要在命令里带上 client id 和 sequence number，由状态机层做去重。

线性一致读也需要额外处理。最保守的方式是把读也走一条日志；更高效的实现可以使用 ReadIndex 或 Leader lease，但必须确保当前 Leader 仍然拥有多数派意义上的领导权。否则，旧 Leader 在分区中服务读请求，可能读到过期状态。

## 回到实现本身

把 Raft 放回 MIT 6.824 的实验里看，它不是一篇论文的复述，而是一套被测试不断逼出来的工程约束：选举要在故障后及时收敛，但不能频繁抖动；日志复制要能处理少数派旧 Leader 留下的冲突日志；提交规则要保护已提交日志不被覆盖；持久化要让节点崩溃后不忘记任期、投票和日志；快照要在不破坏 log index 语义的前提下压缩历史。

理解 Raft 的最好方式，是把 Figure 2 当成协议规格，再把实验里的每个测试用例当成一次故障场景推演。代码最终要表达的不是“发几个 RPC”，而是在任期、角色、日志、提交和应用之间维护一组始终成立的不变量。

## 参考资料

- Diego Ongaro, John Ousterhout, [In Search of an Understandable Consensus Algorithm (Extended Version)](https://raft.github.io/raft.pdf)
- [The Raft Consensus Algorithm](https://raft.github.io/)
- MIT 6.5840, [Lab 3: Raft](https://pdos.csail.mit.edu/6.824/labs/lab-raft1.html)
- MIT OCW 6.033, [Raft Assignment](https://ocw.mit.edu/courses/6-033-computer-system-engineering-spring-2018/pages/week-11/raft-assignment/)
- 小徐先生的编程世界，《[两万字长文解析 raft 算法原理](https://mp.weixin.qq.com/s/nvg9J4ky9mz-dFVi5CyYWg)》
- 小徐先生的编程世界，《[raft 工程化案例之 etcd 源码实现](https://mp.weixin.qq.com/s/jsJ3_E_5IOs4_rPDM5axzQ)》
