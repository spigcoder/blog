# gnet

## 前言

这是我做的第一篇源码分析相关的文章，主要想记录自己从开源项目中学习到的内容，首先在学习一个开源项目之前应该要使用起来，同样，一般这里的使用也是我们分析的入口。

我们首先通过阅读官方文档知道 gnet 原始的做法是不支持我们在业务逻辑中运行一些阻塞代码的，因为 read-compute-write 是一条路，如果我们在 compute 的时候阻塞了，那么当前 subreactor 就不可以监听连接了，这里 gnet 使用了线程池来解决这个问题，做法如图：![image-20260510214539004](/assets/posts/源码分析-gnet-image-20260510214539004-1d4b526f25.png)

![image-20260510214548025](/assets/posts/源码分析-gnet-image-20260510214548025-f1079e33e6.png)

 但其实如果只是看到这里，我们应该都是有一些问题的：

1. 如何处理并发：既然 io thread 可以通过线程池来进行计算，那么我们就无法保证计算结果什么时候返回，这里如果说有多个线程同时返回，我们如何解决并发。
2. 线程间如何通信，compute thread 如何将数据返回给 io thread，让 io thread 来进行数据的响应。

## 源码阅读

首先声明，为了防止文章变得又臭又长，我这里在展示源码的时候仅仅只会展示我认为的核心代码，如果想要了解完整的代码，可以使用 vscode 等工具等搜索功能自行查找。

设计好的地方：epollfd

```go
// Poller represents a poller which is in charge of monitoring file-descriptors.
type Poller struct {
	fd                          int    // epoll fd
	efd                         int    // eventfd
	efdBuf                      []byte // efd buffer to read an 8-byte integer
	wakeupCall                  int32
	asyncTaskQueue              queue.AsyncTaskQueue // queue with low priority
	urgentAsyncTaskQueue        queue.AsyncTaskQueue // queue with high priority
	highPriorityEventsThreshold int32                // threshold of high-priority events
}
```

Poller 对于 Linux 系统来说就是对于 epoll 设置的一些配置，那么这里有一个设计的比较好的地方就是这里的 efd，为什么要有这个东西存在？

正常情况下 epoll 有两种出发方式，边缘触发和水平触发，可是不管哪种触发方式，他们都是对于外来事件的出发，也就是当有新的连接到了，或者之前的连接发送数据了才会被出发，但是如果说我们系统想要唤醒这个 epoll 一般是做不到的，所以我们有了这个 efd 也就是 eventfd，将这个 efd 也注册到 epoll 中，那么当我们需要唤醒 sub reactor 的时候就向 efd 中写入数据就好了。

```go
	// Start sub reactors in the background.
	eng.eventLoops.iterate(func(_ int, el *eventloop) bool {
		eng.concurrency.Go(el.orbit)
		return true
	})
```

这个部分就是 engine 将所有的 reactor 注册 orbit 

```go
func (el *eventloop) orbit() error {
	err := el.poller.Polling(func(fd int, ev netpoll.IOEvent, flags netpoll.IOFlags) error {
		c := el.connections.getConn(fd)
		if c == nil {
			return el.poller.Delete(fd)
		}
		return c.processIO(fd, ev, flags)
	})
}
// processIO 就是真正的处理数据的地方 
func (c *conn) processIO(_ int, filter netpoll.IOEvent, flags netpoll.IOFlags) (err error) {
	el := c.loop
	switch filter {
	case unix.EVFILT_READ:
		err = el.read(c)
	case unix.EVFILT_WRITE:
		err = el.write(c)
	}
	return
}

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
  // 调用我们的处理方法
	action := el.eventHandler.OnTraffic(c)
	switch action {
	case None:
	case Close:
		return el.close(c, nil)
	case Shutdown:
		return errorx.ErrEngineShutdown
	}
	return nil
}
```

前面的都是 SubReactor，然后下面是 MainReactor

```go
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
	// Start the main reactor in the background.
	eng.concurrency.Go(el.rotate)

//上面就是监听= listener
```

```go
func (el *eventloop) rotate() error {
	if el.engine.opts.LockOSThread {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
	}

	err := el.poller.Polling(el.accept0)
}

func (el *eventloop) accept0(fd int, _ netpoll.IOEvent, _ netpoll.IOFlags) error {
	for {
		nfd, sa, err := socket.Accept(fd)
    //...
    
    // 获取负载均衡后的 el
		el := el.engine.eventLoops.next(remoteAddr)
		c := newStreamConn(network, nfd, el, sa, el.listeners[fd].addr, remoteAddr)
    // poller.Trigger 就是我们说的唤醒 epoll，然后把这个 c 注册进行
		err = el.poller.Trigger(queue.HighPriority, el.register, c)
}
```

这里还有一个设计就是有两个 Write，一个是Write，一个是 AsyncWrite，第一个是在我们上面说的 OnTraffic 里面由 SubReactor 调用的，还有一个就是我们可以开启一个线程，然后调用 AsyncWrite，他其实就是会唤醒 epoll，然后会把这个任务加入到消息队列里面。