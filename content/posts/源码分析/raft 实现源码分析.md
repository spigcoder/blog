## raft 实现源码分析

本节作为对于之前实现的 mit 6.824 的总结与回顾。

在我看来 raft 算法其实主要有两个关键的内容：

1. 领导者选举
2. 日志复制

其余的包括持久化、follower 日志清理我认为都是在这两个基础上对于 raft 的安全性的一种扩展，所以本节也将以这两个为主要目标，对于raft的实现进行源码分析。

## 领导者选举

首先看一下这里定义的 raft 与领导者 相关的内容：
```go
type Raft struct {
  // ...
	BroadcastTime   int
	ElectionTimeout int
	State           int // 1 - leader, 2 - candidate, 3 - follower
	CurrentTerm     int
	VotedFor        int
	Log             []LogEntry
	CommitIndex     int
	LastApplied     int
	NextIndex       []int
	MatchIndex      []int

	LastIncludedIndex int
	LastIncludedTerm  int
}

type LogEntry struct {
	Command interface{}
	Term    int
	Index   int
}
```

Raft使用心跳机制来触发**领导者**选取，当服务器加入Raft集群时，其首先以**追随者**身份开始，只要其不断接收到来自服务器的有效RPC请求，其就保持追随者身份。当追随者在一定时间（选举超时时间）内没有接收到有效RPC，其将转换为**候选者**身份并开始选举试图称为领导者。为了避免追随者发起选举，领导者需要定时发送心跳RPC以告知领导者，直到其崩溃或从网络中断开。

我们在学习 raft 算法的时候了解到这里的超时时间应该设置为不一样的，目的是防止 raft 集群中的节点同时醒来，同时投递给自己，然后请求其余投票的时候发现失败从而导致一直没有领导者选举成功，代码如下所示：

```go
func GetElectionTimeout() int {
	rand.Seed(time.Now().UnixNano())
	return ELECTIONTIMEOUTBASE + int(rand.Int31n(ELECTIONTIMEOUTRANGE))
}
```

当服务器开始选举时，追随者将增加其当前term，并转换成候选者。然后，它将为自己投票，并且向集群中的其他服务器并行的发送请求选票RPC请求（`RequestVote`），直到三件事中的一件发生：（1）它获得了大多数选票，赢得选取；（2）另一个服务器赢得选取；（3）在**选举超时时间**内仍未取得胜利。

当服务器赢得选取时，它将立即向其他服务器发送心跳RPC，以防止新的选举发生。在等待`RequestVote`返回时，候选者可能受到来自其他服务器的`AppendEntries`RPC请求（心跳RPC或日志复制RPC），如果发送该请求的领导者term至少与候选者的term一样大，则候选者承认领导者是合法的，并返回到追随者状态。

Raft中有两个地方将用到选举超时时间：

1. 当候选者开始选举时，其将在**选举超时时间**内等待其他服务器的投票结果，直到其获得胜利或等待超过**选举超时时间**；
2. 当服务器转换为追随者状态时，其将更新其**选举超时时间**，如服务器在超过**选举超时时间**的时间内未接受到有效RPC请求，则开始选举。如接受到有效RPC，则重新更新**选举超时时间**。

算法的主体如下所示：
```go
func Make(peers []*labrpc.ClientEnd, me int,
	persister *Persister, applyCh chan ApplyMsg, name string) *Raft {
	// ...
	go rf.ticker()
	return rf
}

func (rf *Raft) ticker() {
	for rf.killed() == false {
		rf.mu.Lock()
		rf.UpdateApplied()
		State := rf.State
    
		if State == LEADER {
			rf.leaderTask()
		} 
    
    else if State == FOLLOWER {
			rf.DPrintf("[%d] ElectionTimeout = %d", rf.me, rf.ElectionTimeout)
			if rf.ElectionTimeout < rf.BroadcastTime {
				rf.State = CANDIDATE
				rf.DPrintf("[%d] ElectionTimeout,convert to CANDIDATE\n", rf.me)
				rf.mu.Unlock()
				continue
			}
			rf.ElectionTimeout -= rf.BroadcastTime
			rf.mu.Unlock()
			time.Sleep(time.Duration(rf.BroadcastTime) * time.Millisecond)
		} 
    
    else if State == CANDIDATE {
			rf.doElection()
		}
	}
}
```

有上面的代码可以看到，这里的 raft 主要分为两部分，首先就是每次时钟到达的时候会去应用日志，这里的应用日志就是通过 applyChan 将消息发送给上方，让应用方去使用，第二部分就是根据身份来进行相应的工作，本章主要是讲选举相关的内容，所以主要来看 leader 和 canidate 所做的关于选举的动作

### leader

关于 leader 要做的有两部分，第一点是定时的发送心跳，第二点就是当发送 entry 或者 heartbeat 回复的时候判断响应的 term 是否大于自己，如果是，则降级为 follower

```go
	if reply.Term > rf.CurrentTerm {
		rf.CurrentTerm = reply.Term
		rf.State = FOLLOWER
		rf.ElectionTimeout = GetElectionTimeout()
		rf.VotedFor = -1
		rf.persist()
		rf.mu.Unlock()
		return
	}
```

### candidate

candidate 在刚才的 ticker 中可以看到这里主要就是进行选举，如下代码所示，我这里删除了一些对于信号量的时候，主要聚焦于具体的逻辑理解

```go
func (rf *Raft) doElection() {
	rf.CurrentTerm++
	voteGranted := 1
	rf.VotedFor = rf.me
  // persist 持久化一下内容 CurrentTerm、VotedFor、Log、LastIncludedIndex、LastIncludedTer
	rf.persist()
	term := rf.CurrentTerm
	ElectionTimeout := rf.ElectionTimeout
	var lastLogTerm, lastLogIndex int
  // 获取当前的日志的 term 和 index 主要是判断当前节点是否拥有最新的日志，如果没有怎不能成为 leader
	lastLogIndex = rf.GetLastEntry().Index
	lastLogTerm = rf.GetLastEntry().Term
	for i := 0; i < len(rf.peers); i++ {
		if i != rf.me {
			go func(server int) {
				args := RequestVoteArgs{Term: term, CandidateId: rf.me, LastLogIndex: lastLogIndex, LastLogTerm: lastLogTerm}
				reply := RequestVoteReply{}
        // 调用 RequestVote 函数，下面会分析这个函数的内容
				if !rf.sendRequestVote(server, &args, &reply) {
					return
				}
				if reply.VoteGranted {
          // 节点投票给力自己
					voteGranted++
				}
        // 都到 term 比自己大的节点，降级为 follower
				if reply.Term > rf.CurrentTerm {
					rf.CurrentTerm = reply.Term
					rf.persist()
					rf.State = FOLLOWER
					rf.ElectionTimeout = GetElectionTimeout()
				}
			}(i)
		}
	}
  // 选举超时时间控制
	go func(electionTimeout int, timeout *int32) {
		time.Sleep(time.Duration(electionTimeout) * time.Millisecond)
		atomic.StoreInt32(timeout, 1)
	}(ElectionTimeout, &timeout)
  	// 判断是否自己可以成为 leader
		if voteGranted > len(rf.peers)/2 {
			rf.State = LEADER
			rf.CommitIndex = 0
			for i := 0; i < len(rf.peers); i++ {
        // MatchIndex 表示的是从节点写入的日志，用于计算 commit
				rf.MatchIndex[i] = 0
        // NextIndex 是 leader 认为当前从节点需要的数据，默认初始化为最后的数据，会在提交日志的过程中进行修改
				rf.NextIndex[i] = rf.GetLastEntry().Index + 1
			}
			rf.mu.Unlock()
			rf.TrySendEntries(true)
			break
		}
}
```

### follower

follower 做的主要是接收选举，然后进行投票，在这里会有我们之前所说的安全相关的内容，比如说会判断选举者的日志是不是最新的，是否要对他进行投票

```go
func (rf *Raft) RequestVote(args *RequestVoteArgs, reply *RequestVoteReply) {
	reply.Term = rf.CurrentTerm
	LastEntry := rf.GetLastEntry()
	LastIndex := LastEntry.Index
	LastTerm := LastEntry.Term
	if rf.CurrentTerm > args.Term {
    //当前节点的 term 更大，拒绝投票
		reply.VoteGranted = false
		return
	} else if rf.CurrentTerm < args.Term {
    // 如果更小，就降级为 follower
		rf.State = FOLLOWER
		rf.CurrentTerm = args.Term
		rf.VotedFor = -1
		rf.persist()
	}
  // 只有当前节点没有给其他节点投过票，并且日志比自己要新，才会给他投票
	if rf.VotedFor == -1 && (LastTerm < args.LastLogTerm || (LastTerm == args.LastLogTerm && LastIndex <= args.LastLogIndex)) {
		reply.VoteGranted = true
		rf.VotedFor = args.CandidateId
		rf.persist()
		rf.ElectionTimeout = GetElectionTimeout()
	}
}
```

以上基本就是选举的大部分内容，当然，这里只是一些算法实现，在工程上其实还有一些预选举的操作，就是当在超时时间内没有收到心跳的话，会先预选举，也就是问其他follower有没有收到心跳，只有一些follower都没有收到的时候才会开启选举，目的是防止因为网络抖动而频繁的更换 leader，感兴趣的可以上网搜索更多的相关内容。

## 日志复制

接下来就是 raft 中的另一个大的模块：日志复制，当leader 收到应用层发出的相关请求的时候，它只有收到超过一半的节点的同意之后才会将其提交。

我们首先来看一下 leader 会做什么内容

```go
func (rf *Raft) TrySendEntries(initialize bool) {
	for i := 0; i < len(rf.peers); i++ {
		nextIndex := rf.NextIndex[i]
		firstLogIndex := rf.GetFirstEntry().Index
		lastLogIndex := rf.GetLastEntry().Index
		if i != rf.me {
			if lastLogIndex >= nextIndex || initialize {
				if firstLogIndex <= nextIndex {
					go rf.SendEntries(i)
				} else {
          // 目前需要的日志都没有了，发送快照
					go rf.SendSnapshot(i)
				}
			} else {
				go rf.SendHeartBeat(i)
			}
		}
	}
}
```

这里有一点要注意的就是其实 SenEntries 也是 SendHeartBeat，所以在发送数据的时候就不需要发送心跳了，他们调用的函数都是一样的，都是AppendEntries。

我们先来看一下 SenE'n'tries:

```go
func (rf *Raft) SendEntries(server int) {
	done := false
	for !done {
		if rf.State != LEADER {
			rf.mu.Unlock()
			return
		}
    // LastIncludedIndex 表示的是目前日志中还有的最小index，如果比这个小，证明之前的日志已经作为快照了，要发送快照。
		if rf.NextIndex[server] <= rf.LastIncludedIndex {
			rf.mu.Unlock()
			return
		}
		done = true
    // 根据当前 i 的信息来发送对应的日志
		term := rf.CurrentTerm
		leaderCommit := rf.CommitIndex
		prevLogIndex := rf.NextIndex[server] - 1
		prevLogTerm := rf.GetLogIndex(prevLogIndex).Term
		entries := rf.Log[prevLogIndex-rf.LastIncludedIndex:]
		args := AppendEntriesArgs{Term: term, LeaderId: rf.me, PrevLogIndex: prevLogIndex, PrevLogTerm: prevLogTerm, Entries: entries, LeaderCommit: leaderCommit}
		reply := AppendEntriesReply{}
		if !rf.sendAppendEntries(server, &args, &reply) {
			return
		}
		rf.mu.Lock()
    // 之前讲的，如果返回的term更大，就退回 follower
		if reply.Term > rf.CurrentTerm {
			rf.CurrentTerm = reply.Term
			rf.State = FOLLOWER
			rf.ElectionTimeout = GetElectionTimeout()
			rf.VotedFor = -1
			rf.persist()
			rf.mu.Unlock()
			return
		}
		if !reply.Success {
			// 意味着当前发送的日志和 follower 拥有的最后一个不相同，这要先帮 folloer 补齐日志
			if reply.XLen < prevLogIndex {
				rf.NextIndex[server] = Max(reply.XLen, 1)
			} else {
				newNextIndex := prevLogIndex
				for newNextIndex > rf.LastIncludedIndex && rf.GetLogIndex(newNextIndex).Term > reply.XTerm {
					newNextIndex--
				}
				if rf.GetLogIndex(newNextIndex).Term == reply.XTerm {
					rf.NextIndex[server] = Max(newNextIndex, rf.LastIncludedIndex+1)
				} else {
					rf.NextIndex[server] = reply.XIndex
				}
			}
			done = false
		} else {
      // MatchIndex 是表示这些日志 follower 都已经写入了，用来 commit 日志
			rf.NextIndex[server] = Max(rf.NextIndex[server], prevLogIndex+len(entries)+1)
			rf.MatchIndex[server] = Max(rf.MatchIndex[server], prevLogIndex+len(entries))
		}
	}
}
```

发送心跳和快照与发送日志几乎一模一样，这里就不再过多的介绍，这里主要再讲一下当folloer接收到日志的时候会做什么

```go
func (rf *Raft) AppendEntries(args *AppendEntriesArgs, reply *AppendEntriesReply) {
	reply.Term = rf.CurrentTerm
	reply.Success = true
  //收到心跳或者日志，重置心跳时间
	rf.ElectionTimeout = GetElectionTimeout()
	if args.Term < rf.CurrentTerm || rf.LastIncludedIndex > args.PrevLogIndex {
    //接收到 term 更小的日志，返回错误
		reply.Success = false
		return
	}
	if rf.CurrentTerm < args.Term || rf.State == CANDIDATE {
    // 退位为 follower
		rf.State = FOLLOWER
		rf.CurrentTerm = args.Term
		rf.VotedFor = -1
		rf.cond.Broadcast()
		rf.persist()
	}
	if rf.GetLastEntry().Index < args.PrevLogIndex || args.PrevLogTerm != rf.GetLogIndex(args.PrevLogIndex).Term {
    // 最后一个日志与 leader 发送来的 pre 不匹配
		reply.XLen = rf.GetLastEntry().Index
		if rf.GetLastEntry().Index >= args.PrevLogIndex {
			reply.XTerm = rf.GetLogIndex(args.PrevLogIndex).Term
			reply.XIndex = args.PrevLogIndex
			for reply.XIndex > rf.LastIncludedIndex && rf.GetLogIndex(reply.XIndex).Term == reply.XTerm {
				reply.XIndex--
			}
			reply.XIndex++
		}
		reply.Success = false
		return
	}
	for index, entry := range args.Entries {
		if rf.GetLastEntry().Index < entry.Index || entry.Term != rf.GetLogIndex(entry.Index).Term {
			var log []LogEntry
			for i := rf.LastIncludedIndex + 1; i <= entry.Index-1; i++ {
				log = append(log, rf.GetLogIndex(i))
			}
			log = append(log, args.Entries[index:]...)
			rf.Log = log
			rf.persist()
		}
	}
	if args.LeaderCommit > rf.CommitIndex {
    // 更新 commit 的内容
		rf.CommitIndex = Min(args.LeaderCommit, rf.GetLastEntry().Index)
	}
}
```

以上基本上就是代码的全部实现，感谢阅读。

## 参考资料

- `https://github.com/jlu-xiurui/MIT6.824-labs`
- `小徐先生的编程世界，《两万字长文解析 raft 算法原理》`
- `小徐先生的编程世界，《[raft 工程化案例之 etcd 源码实现》](https://mp.weixin.qq.com/s/jsJ3_E_5IOs4_rPDM5axzQ)`
- `MIT 6.5840, [Lab 3: Raft](https://pdos.csail.mit.edu/6.824/labs/lab-raft1.html)`

