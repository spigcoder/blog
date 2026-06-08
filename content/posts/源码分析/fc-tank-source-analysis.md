---
title: "FC-Tank 源码分析：从零搭出一个 EasyX 坦克大战项目"
tags: ["C++", "EasyX", "FC-Tank", "源码分析", "游戏开发", "碰撞检测"]
excerpt: "本文以 FC-Tank 的 C++/EasyX 实现为分析对象，用从零搭建项目的顺序讲清主循环、图形化展示、双人输入、共享格子标记、子弹碰撞和关卡推进。"
---

# FC-Tank 源码分析：从零搭出一个 EasyX 坦克大战项目

复刻 FC 坦克大战这类像素风小游戏，难点通常不在“把一张坦克图片画出来”，而在如何让图片、地图、碰撞、子弹、道具、音效和双人输入在同一个循环里保持一致。FC-Tank 这个项目使用 C++ 和 EasyX 绘图库实现，工程规模不算大，但已经包含了游戏项目里常见的几条主线：固定逻辑分辨率渲染、资源精灵加载、地图格子标记、玩家和敌人的行为更新、子弹碰撞、道具效果、关卡切换与结算面板。

本文分析的源码来自 `FC-Tank` 项目的主游戏工程 `Tank/Tank`，编译环境在 README 中标注为 VS2022 与 EasyX2023_大暑版。分析范围主要覆盖 `Tank.cpp`、`GameControl`、`PlayerBase`、`EnemyBase`、`TankClass`、`struct` 和 `TimeClock`。地图编辑器 `MapEditor` 不是本文主线，只在说明自定义地图入口时简单提到。

这篇文章会刻意按照“如果自己从零写，应该先写什么、再写什么”的顺序展开。读者不需要先熟悉大型 C++ 项目，只要知道类、对象、指针、数组和简单链表的概念，就可以跟着主线理解代码为什么这样组织。

如果把这个游戏从空项目开始搭出来，比较稳的顺序是：

```text
先定窗口和逻辑画布
  -> 加载图片和音效资源
  -> 写选择界面
  -> 写 GameControl 主控制器
  -> 设计 BoxMarkStruct 作为共享地图
  -> 写玩家 PlayerBase
  -> 写敌人 EnemyBase
  -> 接入子弹、道具、胜负和关卡切换
```

源码本身的调用顺序则是：

```text
程序入口 -> 资源和画布初始化 -> 模式选择 -> 关卡控制 -> 数据更新 -> 画面合成 -> 胜负结算
```

前一条是“开发顺序”，后一条是“运行顺序”。读源码时把这两条线同时放在脑子里，就不会被函数数量和资源文件绕晕。

## 先建立一张项目地图

初学者读这个项目时，最容易犯的错误是从某个很长的函数里硬啃细节。更好的方式是先问三个问题：谁创建游戏对象，谁保存游戏状态，谁每一帧更新画面。

在 FC-Tank 中，答案分别是：

```text
Tank.cpp 创建窗口、选择面板和 GameControl
GameControl 保存关卡、玩家、敌人、地图和胜负状态
PlayerBase / EnemyBase 保存单个坦克自己的状态
```

可以先把这几个文件当成“房间”来看：`Tank.cpp` 是大厅，玩家先从这里进来；`GameControl` 是调度室，所有关卡流程都在这里安排；`PlayerBase` 和 `EnemyBase` 是具体演员，负责移动、开火、死亡和绘制；`struct.h` 是公共规则表，格子大小、方向编号、地图标记、子弹标记都在里面。

## 先看整体架构：谁负责什么

项目里最核心的对象有四类。

`Tank.cpp` 是程序入口，负责初始化 EasyX 窗口、初始化音效和坦克资源、创建选择面板和游戏控制器。它不直接处理碰撞，也不直接更新玩家和敌人。

`GameControl` 是关卡和主循环控制器。它持有玩家链表 `PlayerList`、敌人链表 `EnemyList`、地图标记结构 `BoxMarkStruct`，并负责加载地图、添加敌人、刷新右侧信息栏、刷新中间战场、判断胜负和切换关卡。

`PlayerBase` 表示一个玩家。双人模式本质上就是创建两个 `PlayerBase` 实例，每个实例有自己的坐标、方向、生命、子弹、爆炸、出生闪烁、保护圈和记分数据。

`EnemyBase` 表示敌人基类，`CommonTank`、`PropTank`、`BigestTank` 继承它来实现不同颜色和血量的敌人坦克。敌人的移动、发射、碰撞检测和爆炸大部分复用基类逻辑。

这几个对象之间的关系可以简化成：

```text
main
  -> SelectPanel：显示选择界面，返回单人/双人/自定义地图
  -> GameControl：管理关卡和主循环
       -> PlayerBase：处理玩家输入、移动、子弹、道具、死亡
       -> EnemyBase：处理敌人出生、移动、子弹、死亡
       -> BoxMarkStruct：所有实体共享的地图/碰撞标记
```

这里最重要的是 `BoxMarkStruct`。它不是普通地图数据，而是运行时共享状态：地图障碍、玩家、敌人、子弹、道具都会在里面留下标记。玩家移动时查它，敌人出生时查它，子弹碰撞时也查它。只要讲清楚这张“运行时地图”，很多问题都会自然串起来。

如果自己从零写，类的出现顺序可以这样安排。先写 `struct.h` 里的尺寸、方向和标记常量，因为后面的所有类都要依赖这些公共规则；再写 `TankClass` 负责加载坦克图片，否则玩家和敌人没有图可画；接着写 `PlayerBase` 和 `EnemyBase`，让坦克能移动和开火；最后写 `GameControl` 把玩家、敌人、地图、右侧面板和胜负流程组织到一个循环里。

用非常简化的伪代码表示，项目骨架大概是：

```cpp
// 公共规则
struct BoxMarkStruct {
    int box_8[26][26];
    int box_4[52][52];
    int prop_8[26][26];
    int bullet_4[52][52];
};

// 单个玩家
class PlayerBase {
public:
    void PlayerControl();
    void DrawPlayerTank(const HDC&);
    BulletShootKind BulletMoving(const HDC&);
};

// 单个敌人
class EnemyBase {
public:
    void TankMoving(const HDC&);
    void DrawTank(const HDC&);
    BulletShootKind BulletMoving();
};

// 一整局游戏
class GameControl {
public:
    void AddPlayer(int player_num);
    void LoadMap();
    void GameLoop();
private:
    list<PlayerBase*> PlayerList;
    list<EnemyBase*> EnemyList;
    BoxMarkStruct* mBoxMarkStruct;
};
```

源码里当然比这复杂，但复杂度主要是围绕这个骨架长出来的：图片、音效、道具、爆炸、结算面板都是给这套骨架补细节。读者只要先抓住骨架，再看具体函数，就不会把“资源加载代码”和“游戏规则代码”混在一起。

## 程序入口：固定画布和两个面板对象

入口函数位于 `Tank.cpp`。核心初始化代码可以概括为：

```cpp
MciSound::InitSounds();
TankInfo::Init();

initgraph(WINDOW_WIDTH, WINDOW_HEIGHT);
BeginBatchDraw();

IMAGE canvas_img(CANVAS_WIDTH, CANVAS_HEIGHT);

HDC des_hdc = GetImageHDC();
HDC canvas_hdc = GetImageHDC(&canvas_img);

SelectPanel* selecter = new SelectPanel(des_hdc, canvas_hdc);
GameControl* control = NULL;
```

这段代码解决三个问题。

第一，`MciSound::InitSounds()` 和 `TankInfo::Init()` 提前加载音效与坦克资源。坦克精灵比较多，按颜色、等级、方向和动画帧组织，提前初始化可以避免游戏过程中频繁读文件。

第二，`initgraph(WINDOW_WIDTH, WINDOW_HEIGHT)` 创建真实窗口，窗口大小是 `512 x 448`；而 `canvas_img` 是逻辑画布，大小是 `256 x 224`。这两个尺寸不是随便选的：逻辑画布保持 FC 风格的低分辨率像素布局，真实窗口则把它放大两倍显示。

第三，`des_hdc` 表示目标窗口的绘图设备，`canvas_hdc` 表示离屏画布的绘图设备。后续大部分内容先画到 `canvas_hdc`，再一次性拉伸到 `des_hdc`。这就是项目图形化展示的基础。

主循环根据选择面板返回结果创建游戏：

```cpp
result = selecter->ShowSelectPanel();

switch (result)
{
    case OnePlayer:
        control->AddPlayer(ONE_PLAYER);
        control->LoadMap();
        control->GameLoop();
        break;

    case TwoPlayer:
        control->AddPlayer(TWO_PLAYER);
        control->LoadMap();
        control->GameLoop();
        break;

    case Custom:
        control->CreateMap(&isCustomMap);
        break;
}
```

可以把 `Tank.cpp` 理解为“总开关”：先让玩家选模式，再把具体游戏过程交给 `GameControl`。这也是答辩时可以强调的一点：入口函数没有塞入大量游戏逻辑，主循环被封装到控制器里，职责比较清楚。

如果是自己动手写，入口函数不要一开始就写玩家移动和碰撞。它只应该完成三件事：创建窗口、创建选择界面、根据选择结果进入游戏。这样做的好处是，当后面玩家移动出 bug 时，不需要回到入口函数里找原因；入口函数只负责“启动”，不负责“怎么玩”。

这里还有一个 C++ 小细节。源码里使用了 `new SelectPanel(...)` 和 `new GameControl(...)`，说明对象创建在堆上，需要在合适时机 `delete`。项目在重新开始普通关卡前会删除旧的 `GameControl`，避免一直保留旧关卡的玩家和敌人状态。对初学者来说，可以先把它理解成：`new` 创建一个长期存在的对象，`delete` 表示这段游戏流程结束后把它释放掉。

## 图形化展示：先画逻辑画布，再放大到窗口

这个项目的图形展示依赖 EasyX 的 `IMAGE`、`HDC`、`BitBlt`、`TransparentBlt`、`StretchBlt` 和批量绘图。

如果第一次接触 EasyX，可以先把这几个概念翻译成更直观的话。`IMAGE` 是一张可以画东西的图片；`HDC` 是这张图片或窗口对应的“画笔入口”；`BitBlt` 是把一块图片原样复制到另一块地方；`TransparentBlt` 也是复制图片，但会把指定颜色当成透明色；`StretchBlt` 是复制时顺便缩放。这个项目的渲染几乎就是反复做这几件事。

先看几个尺寸常量：

```cpp
#define WINDOW_WIDTH    512
#define WINDOW_HEIGHT   448
#define CANVAS_WIDTH    256
#define CANVAS_HEIGHT   224
#define CENTER_WIDTH    208
#define CENTER_HEIGHT   208
#define CENTER_X        16
#define CENTER_Y        9
```

真实窗口是 `512 x 448`，逻辑画布是 `256 x 224`，中间战场是 `208 x 208`。中间战场左上角位于逻辑画布的 `(16, 9)`，右侧剩余区域用于敌人数量、玩家生命和关卡信息。

`GameControl` 构造函数里还有一张中间战场专用画布：

```cpp
mCenterImage.Resize(CENTER_WIDTH, CENTER_HEIGHT);
mCenter_hdc = GetImageHDC(&mCenterImage);
```

所以项目里实际有三层画布：

```text
mCenter_hdc：208 x 208，只负责中间战场
mImage_hdc ：256 x 224，负责完整逻辑画布，包括战场和右侧面板
mDes_hdc   ：512 x 448，真实窗口
```

一帧画面的合成流程是：

```text
清空/绘制中间战场 mCenter_hdc
  -> 把 mCenter_hdc 贴到 mImage_hdc 的 CENTER_X, CENTER_Y
  -> 把 mImage_hdc 拉伸到 mDes_hdc
  -> FlushBatchDraw() 刷新窗口
```

对应代码在 `GameControl::StartGame()` 中：

```cpp
RefreshRightPanel();
RefreshCenterPanel();

BitBlt(mImage_hdc, CENTER_X, CENTER_Y,
       CENTER_WIDTH, CENTER_HEIGHT,
       mCenter_hdc, 0, 0, SRCCOPY);

StretchBlt(mDes_hdc, 0, 0,
           WINDOW_WIDTH, WINDOW_HEIGHT,
           mImage_hdc, 0, 0,
           CANVAS_WIDTH, CANVAS_HEIGHT,
           SRCCOPY);

FlushBatchDraw();
```

这里有两个关键点。

第一，`BitBlt` 是等比例拷贝，不缩放。它把 `208 x 208` 的战场贴进 `256 x 224` 的逻辑画布。

第二，`StretchBlt` 是缩放拷贝。它把 `256 x 224` 的逻辑画布整体放大到 `512 x 448` 的真实窗口。这样做的好处是所有坐标和碰撞都可以按低分辨率计算，不需要因为窗口放大而改一遍坐标。

这就是像素风游戏常见的“逻辑分辨率”和“显示分辨率”分离。逻辑上只处理 `256 x 224`，视觉上再放大显示。

如果自己从零写，第一版可以先不管坦克和地图，只验证三层画布能不能正常工作。也就是先创建窗口，再创建 `canvas_img`，在 `canvas_hdc` 上画一个黑色矩形，最后用 `StretchBlt` 放大到窗口。这个步骤跑通后，再往 `mCenter_hdc` 里画地图和坦克。这样调试会轻松很多，因为如果画面是黑的，可以先判断是资源没加载，还是画布没有拷贝到窗口。

## 为什么要用批量绘图

入口处调用了：

```cpp
BeginBatchDraw();
```

每帧末尾再调用：

```cpp
FlushBatchDraw();
```

如果每画一个对象就立刻刷新窗口，画面会闪烁：背景刚画完、坦克还没画完时，玩家就可能看到半成品。批量绘图的意思是先把一帧完整内容画到缓冲区，最后一次性提交。

选择面板里也能看到这个思路：

```cpp
BitBlt(mImage_hdc, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT,
       GetImageHDC(&mSelect_player_image), 0, 0, SRCCOPY);

StretchBlt(mDes_hdc, 0, mSelect_player_image_y,
           WINDOW_WIDTH, WINDOW_HEIGHT,
           mImage_hdc, 0, 0,
           CANVAS_WIDTH, CANVAS_HEIGHT,
           SRCCOPY);

FlushBatchDraw();
```

选择界面不是简单贴图，而是让选择界面从下往上滑入。`mSelect_player_image_y` 从窗口高度逐渐减少到 0，每次用 `StretchBlt` 画到不同的 y 坐标，就形成了进入动画。

自己实现选择界面时，可以先只写一个静态背景，再加上“坦克光标”。源码里的光标动画不是复杂动画系统，而是准备两张坦克图，用 `mCounter` 在两张图之间切换：

```cpp
TransparentBlt(mImage_hdc,
    mSelectTankPoint[mSelectIndex].x,
    mSelectTankPoint[mSelectIndex].y,
    16, 16,
    GetImageHDC(&mSelectTankImage[mCounter]),
    0, 0, 16, 16,
    0x000000);
```

`mSelectIndex` 决定光标在哪一行，`mCounter` 决定当前用第几张坦克图。对初学者来说，这就是最朴素的动画：同一个位置反复画不同图片，看起来就动了。

## 图片资源如何组织：方向、等级和动画帧

坦克移动时有履带动画。实现方式不是运行时旋转图片，而是提前准备多张 GIF，然后按方向和帧切换。

`TankInfo::Init()` 会加载敌人坦克的静态资源：

```cpp
for (int i = 0; i < 4; i++)
{
    for (int j = 0; j < 4; j++)
    {
        _stprintf_s(c, L"./res/big/gray-tank/%d-%d-1.gif", i + 1, j + 1);
        loadimage(&mGrayTank[i][j][0], c);

        _stprintf_s(c, L"./res/big/gray-tank/%d-%d-2.gif", i + 1, j + 1);
        loadimage(&mGrayTank[i][j][1], c);
    }
}
```

这里的三维数组可以这样理解：

```text
颜色坦克[等级][方向][动画帧]
```

玩家坦克通过 `PlayerTank` 持有 4 个等级的 `TankInfo`：

```cpp
for (int i = 0; i < 4; i++)
    mTankInfo[i] = new TankInfo(player, i);
```

绘制时，`PlayerBase::DrawPlayerTank()` 会根据当前等级、方向和是否移动取图：

```cpp
IMAGE tank = mPlayerTank->GetTankImage(mPlayerTankLevel, mTankDir, mMoving);
TransparentBlt(canvas_hdc,
    mTankX - BOX_SIZE, mTankY - BOX_SIZE,
    BOX_SIZE * 2, BOX_SIZE * 2,
    GetImageHDC(&tank), 0, 0,
    BOX_SIZE * 2, BOX_SIZE * 2,
    0x000000);
```

`TransparentBlt` 的最后一个参数是透明色。项目里的坦克图片以黑色为透明背景，所以这里传 `0x000000`。有些图标背景是白色，比如右侧面板的小图标，绘制时会传 `0xffffff`。

这也解释了为什么代码里同样是 `TransparentBlt`，透明色有时是黑色，有时是白色：取决于资源图片本身的背景色。

如果自己写资源加载，不建议一开始就把所有图片散落在玩家类、敌人类和控制器里。这个项目把坦克图片集中到 `TankInfo` 和 `PlayerTank`，思路是正确的：图片怎么按等级、方向和动画帧找到，交给资源类；玩家和敌人只关心“我现在是什么方向、什么等级、是不是在移动”。这能减少后面改资源路径时的混乱。

## 主循环：绘图和数据更新分开

游戏循环从 `GameControl::GameLoop()` 进入：

```cpp
MciSound::_PlaySound(S_START);
CutStage();
ShowStage();

while (result != GameResult::Fail)
{
    result = StartGame();
    Sleep(1);
}
```

`CutStage()` 是关卡进入前的黑幕动画，`ShowStage()` 显示当前关卡号，之后每次调用 `StartGame()` 推进一小步游戏。

`StartGame()` 的结构很重要：

```cpp
if (mMainTimer.IsTimeOut())
{
    AddEnemy();
    RefreshRightPanel();
    RefreshCenterPanel();

    BitBlt(...);
    StretchBlt(...);
    FlushBatchDraw();
}

RefreshData();
return GameResult::Victory;
```

注意这里不是每次循环都绘图。绘图受 `mMainTimer` 控制，`mMainTimer.SetDrtTime(14)` 表示大约每 14ms 允许刷新一次画面。数据更新 `RefreshData()` 放在外面，循环每次都会尝试处理输入、子弹和敌人移动。

这种拆法有一个好处：画面刷新和逻辑推进不完全绑死。虽然这个项目还不是严格的固定时间步游戏引擎，但已经有意识地区分了“什么时候画”和“什么时候更新状态”。

`TimeClock` 用 Windows 高精度计时器实现：

```cpp
bool TimeClock::IsTimeOut()
{
    QueryPerformanceCounter(&litmp);
    QPart2 = litmp.QuadPart;

    if (((double)(QPart2 - QPart1) * 1000) / dfFreq > drtTime)
    {
        QPart1 = QPart2;
        return true;
    }
    return false;
}
```

这段代码的意思是：当前时间与上次记录时间相差超过 `drtTime` 毫秒，就返回 `true` 并重置起点。玩家移动、子弹速度、敌人移动、爆炸动画、敌人暂停、GameOver 字样上移都用这种计时器控制。

从零写主循环时，可以先写成最简单的三步：

```text
处理输入 -> 更新坐标 -> 重画画面
```

等这三步跑通后，再把“重画画面”交给 `mMainTimer` 控制，把“玩家移动”“子弹移动”“敌人移动”分别交给自己的 `TimeClock` 控制。这样就能理解源码为什么有很多计时器：它们不是为了炫技，而是因为坦克、子弹、爆炸和 GameOver 动画不应该使用同一个速度。

`StartGame()` 还有一个初学者容易看反的地方：它先在定时条件里画画，再在外面调用 `RefreshData()`。实际效果是每次循环都尽量更新数据，但画面按固定节奏刷新。也就是说，`RefreshData()` 更像游戏世界的“状态推进”，`RefreshCenterPanel()` 和 `RefreshRightPanel()` 更像“把当前状态拍成一帧图”。这个区分会贯穿后面的玩家、敌人和子弹逻辑。

## 运行时地图：`BoxMarkStruct` 是碰撞系统的核心

项目里最值得重点讲的是 `BoxMarkStruct`：

```cpp
struct BoxMarkStruct
{
    int box_8[26][26];
    int box_4[52][52];
    int prop_8[26][26];
    int bullet_4[52][52];
};
```

中间战场是 `208 x 208` 像素。项目把它拆成两种粒度：

```text
26 x 26 个 8x8 格子
52 x 52 个 4x4 小格子
```

为什么要两套格子？

`box_8` 适合表示地图块，例如森林、冰、河、砖墙、铁墙、大本营。这些元素本来就是 8x8 粒度绘制的。坦克移动时也常用它判断前方是否有障碍。

`box_4` 更细，适合表示坦克和子弹的碰撞。坦克是 `16 x 16`，刚好占 `4 x 4` 个 4x4 小格子；子弹弹头也按 4x4 粒度检测。砖墙被打掉时，也可以只打掉一部分 4x4 小块，而不是整块 8x8 直接消失。

地图标记常量在 `struct.h` 中定义：

```cpp
#define _EMPTY   0
#define _FOREST  1
#define _ICE     2
#define _WALL    3
#define _RIVER   4
#define _STONE   5

#define PLAYER_SIGN 100
#define ENEMY_SIGN  10000
#define E_B_SIGN    300
#define P_B_SIGN    400
#define WAIT_UNSIGN 444
```

这里有一个很实用的约定：`_FOREST` 和 `_ICE` 的值小于等于 2，坦克可以进入；`_WALL`、`_RIVER`、`_STONE` 大于 2，坦克不能进入。于是移动检测里可以写成：

```cpp
if (temp1 > 2 || temp2 > 2)
    return false;
```

这不是随意比较数字，而是利用了常量值设计。答辩时可以说：项目通过标记值的大小区间把“可通行”和“不可通行”编码进了地图数组。

如果自己从零写坦克大战，强烈建议先写这张表，再写玩家移动。原因很简单：没有共享地图时，玩家只能“看起来移动”，但不知道哪里是墙、哪里是河、哪里有敌人；有了共享地图，移动就变成了“先问地图能不能走，能走再改坐标”。

初学者可以把 `BoxMarkStruct` 想成四张透明纸叠在战场上：

```text
box_8    ：地形纸，记录墙、森林、冰、河、石头和大本营
box_4    ：实体纸，记录玩家、敌人和被打碎的墙块
prop_8   ：道具纸，记录当前道具出现在哪个 8x8 区域
bullet_4 ：子弹纸，记录当前子弹弹头在哪个 4x4 小格
```

画面上看到的是图片，逻辑里判断的是这些数字标记。图片负责“显示给人看”，标记负责“告诉程序能不能走、有没有打中”。这是理解整个项目最关键的一层。

## 地图加载：从文件到碰撞标记

关卡地图保存在 `res/data/map.dat` 中。`GameControl::LoadMap()` 根据当前关卡号读取对应的 `Map`：

```cpp
fseek(fp, sizeof(Map) * (mCurrentStage - 1), SEEK_SET);
fread(&mMap, sizeof(Map), 1, fp);
```

读取后调用 `InitSignBox()`：

```cpp
for (int i = 0; i < 26; i++)
{
    for (int j = 0; j < 26; j++)
    {
        mBoxMarkStruct->prop_8[i][j] = _EMPTY;
        mBoxMarkStruct->box_8[i][j] = mMap.buf[i][j] - '0';
        SignBox_4(i, j, mMap.buf[i][j] - '0');
    }
}
```

这里有一个容易忽略的点：地图文件只填充 `box_8`，但运行时马上同步到 `box_4`。`GameControl::SignBox_4(i, j, sign_val)` 会把一个 8x8 格子拆成 4 个 4x4 小格：

```cpp
int temp_i[4] = { 2 * i, 2 * i + 1, 2 * i, 2 * i + 1 };
int temp_j[4] = { 2 * j, 2 * j, 2 * j + 1, 2 * j + 1 };

for (int i = 0; i < 4; i++)
    mBoxMarkStruct->box_4[temp_i[i]][temp_j[i]] = sign_val;
```

这一步是为了后续子弹打墙。地图展示可以按 8x8 画，但子弹击中砖墙时要能打掉半块甚至四分之一块，所以需要 4x4 粒度。

大本营附近的墙不是完全依赖地图文件，而是在初始化时额外标记：

```cpp
for (int i = 23; i < 26; i++)
{
    for (int j = 11; j < 15; j++)
    {
        if (i >= 24 && j >= 12 && j <= 13)
            mBoxMarkStruct->box_8[i][j] = CAMP_SIGN;
        else
            mBoxMarkStruct->box_8[i][j] = _WALL;
    }
}
```

也就是说，大本营区域有特殊标记 `CAMP_SIGN`，周围自动生成砖墙。这让游戏结束判断更简单：子弹检测到 `CAMP_SIGN`，就可以触发大本营爆炸和失败流程。

从开发顺序看，地图加载这一节应该在玩家移动之前完成。一个可执行的最小版本可以这样做：先手写一个全空的 `box_8`，再在四周填上不可通行的墙，确认玩家不能走出边界；然后再接入 `map.dat`，把文件里的数字读进 `box_8`；最后同步到 `box_4`，让子弹和坦克碰撞也能使用同一份地图信息。

这里的 `mMap.buf[i][j] - '0'` 对 C++ 初学者也值得解释。地图文件读出来的是字符，例如 `'3'`，而 `_WALL` 是整数 `3`。字符 `'3'` 的编码值不是整数 3，所以要减去字符 `'0'`，把字符数字转成真正的整数数字。

## 渲染战场：绘制顺序就是视觉层级

`GameControl::RefreshCenterPanel()` 是中间战场绘制的核心。它不是随便按对象遍历，而是通过绘制顺序实现层级关系。

简化后的顺序如下：

```text
黑色背景
敌人出生四角星
地图底层：墙、冰、河、石头
被打掉的砖墙小块
玩家坦克和玩家子弹
敌人坦克和敌人子弹
森林
爆炸效果
道具
大本营
GameOver / 胜负判断
```

森林为什么放在坦克之后画？因为 FC 坦克大战里，森林会遮住坦克。如果先画森林再画坦克，坦克就会压在森林上，视觉效果不对。代码里也专门把森林独立放到后面：

```cpp
for (int i = 0; i < 26; i++)
{
    for (int j = 0; j < 26; j++)
    {
        if (mBoxMarkStruct->box_8[i][j] == _FOREST)
            TransparentBlt(mCenter_hdc, x, y,
                BOX_SIZE, BOX_SIZE,
                GetImageHDC(&mForestImage),
                0, 0, BOX_SIZE, BOX_SIZE,
                0x000000);
    }
}
```

这段设计很适合讲解图层关系：项目没有引入复杂的图层系统，而是用“绘制先后顺序”实现图层。先画的在下面，后画的在上面。

## 玩家输入：双人模式如何避免键盘冲突

`PlayerBase::PlayerControl()` 是玩家输入处理的核心。每个玩家对象根据自己的 `player_id` 使用不同键位：

```cpp
switch (player_id)
{
case 0:
    // A W D S 移动，J 发射
    break;

case 1:
    // 方向键移动，小键盘 1 发射
    break;
}
```

玩家一使用：

```text
A：左
W：上
D：右
S：下
J：发射
```

玩家二使用：

```text
方向键：移动
小键盘 1：发射
```

双人合作时最容易出现两类冲突。

第一类是“同一个玩家同时按多个方向”。项目用 `if / else if` 串行判断移动方向：

```cpp
if (GetAsyncKeyState('A') & 0x8000)
    Move(DIR_LEFT);
else if (GetAsyncKeyState('W') & 0x8000)
    Move(DIR_UP);
else if (GetAsyncKeyState('D') & 0x8000)
    Move(DIR_RIGHT);
else if (GetAsyncKeyState('S') & 0x8000)
    Move(DIR_DOWN);
```

这意味着同一名玩家如果同时按下多个方向，只有最先匹配的方向生效。以玩家一为例，优先级是 `A -> W -> D -> S`。这样可以避免一次循环里又向左又向上导致状态混乱。

第二类是“移动和发射同时发生”。项目没有把发射写成移动判断链的一部分，而是在移动判断后单独用 `if` 检测：

```cpp
if (GetAsyncKeyState('J') & 0x8000)
{
    if (!ShootBullet(0))
    {
        if (ShootBullet(1))
            MciSound::_PlaySound(S_SHOOT1);
    }
    else
        MciSound::_PlaySound(S_SHOOT0);
}
```

这就允许玩家一边移动一边发射。如果发射也写成 `else if`，那么移动时就无法开火，操作手感会很差。

如果自己写到这里，可以先只支持玩家一。先让 `A/W/D/S` 改变方向和坐标，再加 `J` 发射。等玩家一跑通后，再把“按键表”复制一份给玩家二，而不是复制整套玩家逻辑。源码使用 `player_id` 分支，就是为了让同一个 `PlayerBase` 类同时服务 1P 和 2P。

双人之间的隔离则来自两个方面：

一是键位不重叠。玩家一用 WASD/J，玩家二用方向键/小键盘 1。

二是状态不共用。`GameControl::AddPlayer()` 会创建多个 `PlayerBase` 对象：

```cpp
for (int i = 0; i < player_num; i++)
    PlayerList.push_back(new PlayerBase(i, mBoxMarkStruct));
```

每个玩家对象有自己的坐标、方向、生命、子弹数组、爆炸状态、分数面板。两名玩家共享的只有 `BoxMarkStruct`，也就是地图和碰撞标记。这种设计的效果是：输入和个人状态互相隔离，碰撞和地图占用通过共享结构统一判断。

答辩时如果老师问“两个玩家同时移动到同一个位置怎么办”，可以从 `box_4` 回答。玩家移动前会清除自己的旧位置，检测目标位置是否可进入，移动后再把自己的 16 个 4x4 格子标记为 `PLAYER_SIGN + player_id`。如果另一个玩家已经占用目标格子，`CheckMoveable()` 中的坦克格子检测会失败。

相关逻辑在 `PlayerBase::CheckMoveable()`：

```cpp
bool tank1 = bms->box_4[index_4i + ...][index_4j + ...] <= _ICE;
bool tank2 = bms->box_4[index_4i + ...][index_4j + ...] <= _ICE;
bool tank3 = bms->box_4[index_4i + ...][index_4j + ...] <= _ICE;
bool tank4 = bms->box_4[index_4i + ...][index_4j + ...] <= _ICE;

if (!tank1 || !tank2 || !tank3 || !tank4)
    return false;
```

玩家标记 `PLAYER_SIGN` 是 100，大于 `_ICE`，所以不能通行。敌人标记更大，也不能通行。这就是共享格子标记解决实体重叠的方式。

这里还有一个隐藏前提：游戏循环是单线程顺序执行的，不是两个玩家真的同时在两个线程里移动。程序会按 `PlayerList` 的遍历顺序依次处理玩家。第一个玩家移动后会立刻更新 `box_4`，第二个玩家检测移动时就能看到新的占用状态。也就是说，双人冲突不是靠锁解决，而是靠“单线程顺序更新 + 共享格子标记”解决。对这个项目来说，这种做法足够简单，也足够稳定。

## 玩家移动：先对齐格子，再判断可通行

坦克移动不是简单地每帧 `x += 1` 或 `y += 1`。因为坦克在转向时必须贴合格子，否则碰撞检测会出现几个像素的偏差。

`PlayerBase::Move()` 的流程是：

```text
移动计时器未到 -> 不移动
玩家死亡/爆炸/暂停 -> 不移动
清除旧位置的 box_4 标记
如果方向改变 -> 把坐标对齐到格子线，再修改方向
如果方向不变 -> 检测是否可移动，能移动就更新坐标
把新位置重新标记到 box_4
```

关键代码是：

```cpp
SignBox_4(mTankX, mTankY, _EMPTY);

if (mTankDir != new_dir)
{
    if (mTankDir == DIR_LEFT || mTankDir == DIR_RIGHT)
    {
        if (mTankX > (mTankX / BOX_SIZE) * BOX_SIZE + BOX_SIZE / 2 - 1)
            mTankX = (mTankX / BOX_SIZE + 1) * BOX_SIZE;
        else
            mTankX = (mTankX / BOX_SIZE) * BOX_SIZE;
    }
    else
    {
        if (mTankY > (mTankY / BOX_SIZE) * BOX_SIZE + BOX_SIZE / 2 - 1)
            mTankY = (mTankY / BOX_SIZE + 1) * BOX_SIZE;
        else
            mTankY = (mTankY / BOX_SIZE) * BOX_SIZE;
    }

    mTankDir = new_dir;
}
else
{
    if (CheckMoveable())
    {
        mTankX += mDevXY[mTankDir][0];
        mTankY += mDevXY[mTankDir][1];
    }
}

SignBox_4(mTankX, mTankY, PLAYER_SIGN + player_id);
```

这里最值得解释的是“转向时不立即移动，而是先调正坐标”。比如坦克横向移动时，`x` 可能不在 8 像素格线正中；如果此时直接向上移动，它的碰撞盒会卡在两个格子之间。项目通过取整到最近格线，保证坦克转向后仍然落在规则网格上。

`CheckMoveable()` 还处理边界和障碍物。如果下一步超出 `208 x 208` 战场，它会把坐标调整到边界格线上并返回 `false`。如果前方两个 8x8 格子是墙、河、石头，也返回 `false`。

```cpp
if (tempx < BOX_SIZE || tempy < BOX_SIZE ||
    tempy > CENTER_WIDTH - BOX_SIZE ||
    tempx > CENTER_HEIGHT - BOX_SIZE)
{
    // 调整到格子线
    return false;
}
```

注意项目里坦克坐标 `mTankX`、`mTankY` 表示坦克中心点，不是左上角。坦克大小是 `16 x 16`，所以中心点不能小于 `8`，也不能大于 `208 - 8`。

如果自己写玩家移动，可以分成三个小版本。第一个版本只改坐标，不检测墙，让坦克能动起来；第二个版本加入边界检测，不让坦克离开 `208 x 208` 战场；第三个版本再接入 `box_8` 和 `box_4`，让坦克不能穿墙、不能穿河、不能穿过另一个玩家或敌人。

源码最终版本之所以看起来比“坐标加一”复杂，是因为它同时处理了四件事：移动速度由 `TimeClock` 控制；转向前要对齐格子；移动前要清除旧占位；移动后要写入新占位。只要漏掉其中任何一步，都会出现典型 bug：移动太快、转弯卡墙、原地留下不可见障碍、两个坦克重叠。

`SignBox_4(mTankX, mTankY, PLAYER_SIGN + player_id)` 这一行尤其重要。它不是绘图，而是告诉碰撞系统“这个玩家现在占着这 16 个 4x4 小格”。如果只画了坦克图片而不写标记，别的坦克和子弹就不知道这里有玩家。

## 冰面移动：用状态模拟惯性

地图中 `_ICE` 是可通行地形，但它会改变玩家移动体验。`CheckMoveable()` 中会判断前方是否为冰：

```cpp
if (!mOnIce && (temp1 == _ICE || temp2 == _ICE))
    mOnIce = true;

if (mOnIce && temp1 != _ICE && temp2 != _ICE)
    mOnIce = false;
```

玩家按住同方向移动时，如果当前处于冰面，`PlayerControl()` 会开启自动移动：

```cpp
if (mOnIce && mTankDir == DIR_LEFT)
{
    mAutoMove = true;
    mAutoMove_Counter = 0;
    mRandCounter = rand() % 8 + 7;
}
```

主控制函数开头又会继续执行一段自动移动：

```cpp
if (mAutoMove)
{
    if (mAutoMove_Counter++ < mRandCounter)
        Move(mTankDir);
    else
        mAutoMove = false;
}
```

这不是物理引擎，而是用一个简单状态 `mAutoMove` 和计数器模拟“滑行”。优点是实现容易，和现有格子移动系统兼容；限制是滑行距离带随机性，并不是真正根据速度和摩擦计算。

## 子弹系统：发射、移动、标记和碰撞

玩家有两颗子弹槽：

```cpp
BulletStruct mBulletStruct[2];
```

子弹是否可发射，不是用 `bool` 标记，而是用一个特殊坐标：

```cpp
#define SHOOTABLE_X -100
```

当 `mBulletStruct[i].x == SHOOTABLE_X` 时，说明这颗子弹空闲，可以发射。发射时根据坦克方向计算子弹左上角坐标：

```cpp
mBulletStruct[0].x = mTankX + BulletStruct::devto_tank[mTankDir][0];
mBulletStruct[0].y = mTankY + BulletStruct::devto_tank[mTankDir][1];
mBulletStruct[0].dir = mTankDir;
```

为什么需要 `devto_tank`？因为坦克坐标是中心点，而子弹图片需要左上角坐标。不同方向的子弹出膛位置不同，所以用数组统一描述偏移量。

子弹移动时先检测碰撞，再清除旧标记，再更新坐标，最后写入新标记：

```cpp
BulletShootKind kind = CheckBomb(i);
if (kind == BulletShootKind::Camp ||
    kind == BulletShootKind::Player_1 ||
    kind == BulletShootKind::Player_2)
    return kind;

SignBullet(mBulletStruct[i].x, mBulletStruct[i].y, dir, _EMPTY);

mBulletStruct[i].x += mDevXY[dir][0] * mBulletStruct[i].speed[mPlayerTankLevel];
mBulletStruct[i].y += mDevXY[dir][1] * mBulletStruct[i].speed[mPlayerTankLevel];

SignBullet(mBulletStruct[i].x, mBulletStruct[i].y, dir,
           P_B_SIGN + player_id * 10 + i);
```

这里顺序不能乱。先检测可以避免子弹穿过障碍；移动前清除旧标记可以避免旧位置一直被认为有子弹；移动后写入新标记，让下一轮其他子弹或实体能检测到它。

`BulletStruct` 里有一条非常关键的注释：子弹每次移动不能超过 4 个像素，否则会跨越 4x4 格子导致检测 bug。这个限制来自 `bullet_4` 的设计：子弹碰撞是按 4x4 小格子检查的，如果一步跨过超过一个格子，就可能直接跳过墙或子弹。

所以当老师问“为什么子弹速度不能无限调大”，可以回答：这个实现的碰撞检测是离散格子检测，速度过大会发生穿透。要支持更高速度，需要做连续碰撞检测，或者在一次移动中分多步检测中间格子。

如果自己写子弹系统，建议按这个顺序逐步加功能。先让玩家按 `J` 时生成一颗子弹，并让子弹沿当前方向飞出屏幕；再加入 `SHOOTABLE_X` 这样的空闲标记，让同一个子弹槽不能重复发射；接着加入 `bullet_4` 标记，让子弹的位置能被其他子弹检测到；最后再写 `CheckBomb()`，处理边界、墙、铁墙、敌人、玩家和大本营。

项目用 `SHOOTABLE_X = -100` 表示“这颗子弹现在可以发射”，这是一种简单状态编码。它的优点是少一个布尔变量，判断也直接；缺点是读代码时必须知道 `x = -100` 不是一个真实坐标，而是特殊状态。讲解时可以主动说明这一点，避免听的人误以为子弹真的被放在屏幕外某个位置继续运动。

## 子弹互撞：`WAIT_UNSIGN` 解决谁先清除的问题

双人游戏和敌人子弹都可能发生“子弹打子弹”。项目用 `bullet_4` 标记子弹位置：

```cpp
#define E_B_SIGN    300
#define P_B_SIGN    400
#define WAIT_UNSIGN 444
```

玩家子弹检测到另一个玩家或敌人的子弹时：

```cpp
if (bms->bullet_4[b4i][b4j] == P_B_SIGN + ... ||
    bms->bullet_4[b4i][b4j] == E_B_SIGN)
{
    mBulletStruct[i].x = SHOOTABLE_X;
    bms->bullet_4[b4i][b4j] = WAIT_UNSIGN;
    return BulletShootKind::Other;
}
else if (bms->bullet_4[b4i][b4j] == WAIT_UNSIGN)
{
    mBulletStruct[i].x = SHOOTABLE_X;
    bms->bullet_4[b4i][b4j] = _EMPTY;
    return BulletShootKind::Other;
}
```

这个中间状态很有讲解价值。

如果两颗子弹互相击中，第一颗处理到碰撞时不能直接把格子清空。因为第二颗子弹稍后移动时还需要知道“自己也撞到了”。如果第一颗直接清空，第二颗就会以为前方没东西，继续飞行。

所以第一颗把格子改成 `WAIT_UNSIGN`，表示“这里发生了子弹互撞，等另一方也处理”。第二颗看到 `WAIT_UNSIGN` 后，再把格子清成 `_EMPTY`。这相当于用一个临时标记解决同一帧内处理顺序带来的冲突。

这也是项目里处理双人/多实体冲突的一个典型技巧：不引入复杂事件系统，而是在共享格子数组里放一个中间状态。

从零实现时，可以先不写 `WAIT_UNSIGN`，让子弹打墙、打敌人先正常工作。等出现“两个子弹对撞时只有一颗消失”的问题，再引入中间状态。这样就能理解这个标记不是凭空设计出来的，而是为了解决顺序处理带来的状态不一致。

## 子弹打墙：4x4 小格让砖墙可以局部破坏

`PlayerBase::ClearWallOrStone()` 处理子弹打中墙或铁墙。砖墙 `_WALL` 可以被打掉，铁墙 `_STONE` 默认打不掉，只有玩家坦克升到最高级时才能打掉。

以左右方向为例：

```cpp
int temp[4][2] = { {-2, 0}, {-1, 0}, {0, 0}, {1, 0} };

for (int i = 0; i < 4; i++)
{
    tempx = boxi + temp[i][0];
    tempy = boxj + temp[i][1];

    int n = tempx / 2;
    int m = tempy / 2;

    if (bms->box_4[tempx][tempy] == _WALL)
    {
        bms->box_4[tempx][tempy] = _CLEAR;
        ...
        if (isClear)
            bms->box_8[n][m] = _EMPTY;
    }
}
```

为什么左右方向要检测上下相邻的四个 4x4 格子？因为子弹虽然很小，但砖墙是按小块破坏的。左右射击时，弹头会打到一条竖向区域；上下射击时，则会打到一条横向区域。

`_CLEAR` 和 `_EMPTY` 也有区别。

`_CLEAR` 表示这个 4x4 小块刚被打掉，绘制时要用黑色覆盖它。`_EMPTY` 表示 8x8 大格整体已经空了，可以作为空地处理。项目会检查同一个 8x8 格子里的 4 个 4x4 小格是否都被清掉，如果都清掉，才把 `box_8` 设为 `_EMPTY`。

这就是砖墙可以一点点被打碎的原因。

如果只想做一个简化版，子弹打中砖墙时可以直接把整个 8x8 墙块设成 `_EMPTY`。FC-Tank 选择更细的 4x4 破坏，是为了更接近原版效果：一发子弹只打掉砖墙的一部分。这个选择会让代码复杂一些，但也解释了为什么项目同时维护 `box_8` 和 `box_4`。`box_4` 不是多余数组，而是为了支持局部破坏和更精细的碰撞。

## 玩家击中敌人：子弹先记录，控制器再统一处理

玩家子弹检测到敌人时，并不会立刻 `delete` 敌人对象。它只是把击中的敌人标记记录到子弹里：

```cpp
mBulletStruct[i].mKillId = bms->box_4[tempi][tempj];
```

然后 `GameControl::RefreshCenterPanel()` 中调用：

```cpp
CheckKillEnemy(*itor);
```

`CheckKillEnemy()` 再根据 `mKillId` 找到对应敌人：

```cpp
if ((*EnemyItor)->GetId() == bullet[i] % 100)
{
    if ((*EnemyItor)->BeKill(false))
    {
        mKillEnemyNum++;
        mCurMovingTankNumber--;
        ...
    }
}
```

为什么不在 `PlayerBase` 里直接删除敌人？因为敌人链表归 `GameControl` 管理。如果玩家对象直接操作敌人链表，会让职责混乱，也容易在遍历过程中删除对象导致迭代器失效。

这个项目采用的是折中方案：玩家子弹只负责判断“我打中了谁”，控制器负责根据这个结果改变敌人状态和计分。这也是答辩时可以提到的工程边界。

敌人对象被击中后也不是马上从链表中移除。`EnemyBase::BeKill()` 会设置死亡状态、清除格子占用并启动爆炸：

```cpp
mDied = true;
SignBox_4(mTankX, mTankY, _EMPTY);
mBlast.SetBlasting(mTankX, mTankY);
```

爆炸动画显示结束后，`EnemyBase::Blasting()` 返回 `true`。不过源码里当前没有在这一处立即从链表 erase，注释也说明敌人对象会在关卡结算显示分数面板时统一释放。这种做法避免了敌人子弹和爆炸动画还没结束就销毁对象的问题，但也意味着死亡敌人在链表里会停留一段时间，代码需要用 `mDied` 避免它继续移动和绘制坦克本体。

## 敌人生成：最多 6 个活动敌人，总数 20 个

项目定义：

```cpp
#define TOTAL_ENEMY_NUMBER  20
#define ACTIVE_ENEMY_NUMBER 6
```

`GameControl::AddEnemy()` 控制敌人投放：

```cpp
if (mCurMovingTankNumber >= ACTIVE_ENEMY_NUMBER ||
    TOTAL_ENEMY_NUMBER - size <= 0)
    return;

mCurMovingTankNumber++;
```

也就是说，一关总共 20 个敌人，同时场上最多 6 个正在活动。敌人级别根据已经创建的数量分段：

```cpp
if (size < 8)
    level = 0;
else if (size < 13)
    level = 1;
else if (size < 17)
    level = 2;
else
    level = 3;
```

每 5 个敌人中有一个道具坦克：

```cpp
if (size % 5 == 4)
    kind = TANK_KIND::PROP;
else
    kind = TANK_KIND::COMMON;
```

这套规则让游戏难度逐步上升，同时周期性出现道具坦克。`BigestTank` 是高级敌人，拥有 `hp = 4`，被击中多次才会爆炸：

```cpp
if (--hp <= 0 || killanyway)
    return this->EnemyBase::BeKill(killanyway);
```

`killanyway` 用于炸弹道具这类强制击杀场景。普通子弹需要按血量扣减，道具炸弹可以直接击杀。

## 敌人出生：四角星占位避免重叠

敌人不是直接出现在地图上，而是先显示四角星。`EnemyBase::ShowStar()` 调用 `StarClass::EnemyShowStar()`，在四角星开始出现时标记格子：

```cpp
case Star_State::Star_Out:
    SignBox_4(mTankX, mTankY, STAR_SIGN);
    break;
```

四角星结束后，才分配敌人 id，并把格子标记改成敌人：

```cpp
case Star_State::Star_Stop:
    mEnemyId = TOTAL_ENEMY_NUMBER - remainnumber;
    remainnumber -= 1;

    SignBox_4(mTankX, mTankY,
        ENEMY_SIGN + 1000 * mEnemyTankLevel
        + 100 * mEnemyTankKind
        + mEnemyId);
    break;
```

`STAR_SIGN` 的作用是占位。敌人出生动画期间，其他坦克不能移动进来；如果出生点被障碍、玩家或敌人占用，`EnemyShowStar()` 会返回失败并重新选择出生位置。

敌人标记值也经过编码：

```text
ENEMY_SIGN + 1000 * 敌人等级 + 100 * 敌人类型 + 敌人 id
```

这样子弹打中敌人时，不只是知道“这里有敌人”，还可以从标记值里解析敌人等级、类型和 id。比如 `bullet[i] % 100` 获取 id，`bullet[i] % 1000 / 100` 获取敌人类型。

如果自己写敌人出生，第一版可以直接在 `(8, 8)` 之类的位置生成敌人。但很快会遇到两个问题：出生点可能被玩家挡住，多个敌人可能挤在一起。四角星占位就是为了解决这个问题。出生动画开始时先写入 `STAR_SIGN`，其他实体看到这个标记就不能进入；动画结束时再改成真正的 `ENEMY_SIGN`。这让“出生动画”和“碰撞占位”同时成立。

## 敌人移动：随机方向和格子对齐

敌人的移动逻辑和玩家类似，也使用中心点坐标、方向数组、移动计时器和 `box_4` 标记。区别是敌人方向由程序随机调整。

`EnemyBase::TankMoving()` 的流程是：

```cpp
if (!mStar.IsStop() || mDied || !mTankTimer.IsTimeOut())
    return;

SignBox_4(mTankX, mTankY, _EMPTY);

ShootBack();

if (mStep-- < 0)
    RejustDirPosition();

if (CheckMoveable())
{
    mTankX += mDevXY[mTankDir][0] * mSpeed[mEnemyTankLevel];
    mTankY += mDevXY[mTankDir][1] * mSpeed[mEnemyTankLevel];
}
else
{
    RejustDirPosition();
}

SignBox_4(mTankX, mTankY,
    ENEMY_SIGN + mEnemyTankLevel * 1000
    + mEnemyTankKind * 100
    + mEnemyId);
```

`mStep` 可以理解为“当前方向还能走多少步”。步数耗尽或者前方不可走时，敌人会重新调整方向。

`RejustDirPosition()` 也会先把坐标对齐到格子线，再随机选择新方向。这个设计和玩家转向一致，避免敌人卡在半格位置上。

另外还有一个 `ShootBack()`，定时让敌人掉头：

```cpp
int back_dir[4] = { DIR_RIGHT, DIR_DOWN, DIR_LEFT, DIR_UP };
mTankDir = back_dir[mTankDir];
```

它的作用是让敌人不总是沿着一个方向机械移动，增加行为变化。

从实现难度看，敌人移动其实是玩家移动的自动版本。玩家移动的方向来自键盘，敌人移动的方向来自随机数和步数计数；除此之外，它们都需要格子对齐、边界检测、障碍检测和占位标记。因此，如果从零写项目，应该先把玩家移动写稳，再参考玩家移动写敌人移动。这样可以复用很多思路，也更容易解释为什么 `EnemyBase::CheckMoveable()` 和 `PlayerBase::CheckMoveable()` 长得很像。

不过敌人还有一个额外约束：它不能在出生四角星没结束时移动，也不能在死亡爆炸时继续移动。`TankMoving()` 开头的判断就是为这些状态服务：

```cpp
if (!mStar.IsStop() || mDied || mTankTimer.IsTimeOut() == false)
    return;
```

这行代码读起来很普通，但它维护了一个重要边界：只有真正出现在场上、还活着、并且移动计时器到点的敌人，才能改变坐标。

## 道具系统：静态道具对象和共享效果标志

玩家类里有一个静态道具对象：

```cpp
static PropClass mProp;
```

这表示道具不是每个玩家各生成一份，而是全局共享一个当前道具。玩家击中道具坦克后，`GameControl::CheckKillEnemy()` 会调用：

```cpp
PlayerBase::SetShowProp();
```

`SetShowProp()` 随机选择一个可放置位置，然后显示道具：

```cpp
for (int i = 0; i < 50; i++)
{
    n = rand() % 25;
    m = rand() % 25;
    if (CheckBox_8(n, m))
        break;
}

mProp.StartShowProp(n, m);
```

玩家移动时会检测当前占据的几个 `prop_8` 格子：

```cpp
int prop[4] = {
    bms->prop_8[curi][curj],
    bms->prop_8[curi - 1][curj],
    bms->prop_8[curi][curj - 1],
    bms->prop_8[curi - 1][curj - 1]
};
```

拿到道具后进入 `DispatchProp()`：

```cpp
switch (prop_kind)
{
case ADD_PROP:
    mPlayerLife = mPlayerLife + 1 > 5 ? 5 : mPlayerLife + 1;
    break;
case STAR_PROP:
    mPlayerTankLevel = mPlayerTankLevel + 1 > 3 ? 3 : mPlayerTankLevel + 1;
    break;
case TIME_PROP:
    mTimeProp = true;
    break;
case BOMB_PROP:
    mBombProp = true;
    break;
case SHOVEL_PROP:
    mShovelProp = true;
    mShovelProp_counter = 0;
    break;
case CAP_PROP:
    mRing.SetShowable(12000);
    break;
}
```

道具效果分两类。

加命、升星、帽子这类效果直接作用在当前玩家身上。

时钟、炸弹、铲子这类影响全局战场的效果，会通过静态标志传给 `GameControl::RefreshData()` 统一处理。例如时钟道具：

```cpp
if (PlayerBase::IsGetTimeProp())
{
    mEnemyPause = true;
    mEnemyPauseTimer.Init();
    EnemyBase::SetPause(true);
}
```

敌人暂停时间到期后：

```cpp
else if (mEnemyPauseTimer.IsTimeOut())
{
    mEnemyPause = false;
    (*EnemyItor)->SetPause(false);
}
```

这里体现了一个边界：玩家负责“吃到了道具”，控制器负责“让敌人全局暂停”。因为敌人列表和全局状态由 `GameControl` 管理。

如果自己从零写道具，不要一开始就写六种。可以先写一种最容易验证的道具，比如加命：地图上出现一个图标，玩家碰到后生命值加一，图标消失。这个流程跑通后，再把道具类型扩展成编号：`ADD_PROP`、`STAR_PROP`、`TIME_PROP` 等。FC-Tank 的 `DispatchProp()` 就是这个扩展点。

道具系统还有一个适合答辩说明的设计边界：道具图标是否显示、显示在哪里，由 `PropClass` 管；玩家是否碰到道具，由 `PlayerBase` 在移动检测时判断；道具如果影响全体敌人，则通过静态标志交给 `GameControl` 处理。这样不会让 `PropClass` 直接操作敌人链表，也不会让敌人类反过来关心玩家吃了什么道具。

## 友军伤害：玩家子弹不会杀死队友，但会暂停队友

玩家子弹击中另一个玩家时，`CheckBomb()` 返回 `BulletShootKind::Player_1` 或 `Player_2`。`GameControl::RefreshData()` 中处理这个结果：

```cpp
case BulletShootKind::Player_1:
    for (list<PlayerBase*>::iterator i = PlayerList.begin(); i != PlayerList.end(); i++)
    {
        if ((*i)->GetID() == 0)
            (*i)->SetPause();
    }
    break;

case BulletShootKind::Player_2:
    for (list<PlayerBase*>::iterator i = PlayerList.begin(); i != PlayerList.end(); i++)
    {
        if ((*i)->GetID() == 1)
            (*i)->SetPause();
    }
    break;
```

被队友击中不会死亡，只是调用 `SetPause()`。绘制坦克时，如果处于暂停状态，会通过计数器制造闪烁效果，并在一段时间后恢复：

```cpp
if (mPause && mPauseCounter++ / 10 % 2 != 0)
{
    if (mPauseCounter > 266)
        mPause = false;
    return;
}
```

答辩时可以把这解释为“友军火力惩罚”：不扣生命，但短时间不能移动。它也展示了项目如何处理双人合作中的玩家间子弹碰撞。

## 胜负流程：大本营、玩家生命和敌人数量

游戏失败主要有两种情况。

第一，大本营被玩家或敌人子弹击中。子弹检测返回 `BulletShootKind::Camp` 后，`GameControl` 设置 GameOver 状态：

```cpp
mGameOverX = CENTER_WIDTH / 2 - GAMEOVER_WIDTH / 2;
mGameOverY = CENTER_HEIGHT;
mGameOverFlag = true;

mCampDie = true;
mBlast.SetBlasting(11, 23);
```

`mCampDie` 控制大本营绘制毁坏图片，`mBlast` 控制爆炸动画，`mGameOverFlag` 控制 GameOver 字样上移。

第二，所有玩家生命耗尽。`RefreshCenterPanel()` 中会检查：

```cpp
bool player_all_die = true;
for (list<PlayerBase*>::iterator itor = PlayerList.begin(); itor != PlayerList.end(); itor++)
{
    if (!(*itor)->IsLifeEnd())
        player_all_die = false;
}

if (player_all_die && mGameOverFlag == false)
{
    mGameOverFlag = true;
    MciSound::PauseBk(true);
    MciSound::PlayMovingSound(false);
}
```

胜利条件是击杀全部 20 个敌人：

```cpp
if (mKillEnemyNum == TOTAL_ENEMY_NUMBER)
{
    mWinCounter = 0;
    mWin = true;
}
```

胜利后不会马上切关，而是等待一段时间再显示分数面板：

```cpp
if (mWin && mWinCounter++ > 210 &&
    !mGameOverFlag && mShowScorePanel == false)
{
    MciSound::PauseBk(true);
    mShowScorePanel = true;
    ...
}
```

分数面板结束后，如果胜利，就重置关卡状态、玩家保留生命情况并加载下一关：

```cpp
if (mWin)
{
    Init();
    for (list<PlayerBase*>::iterator itor = PlayerList.begin(); itor != PlayerList.end(); itor++)
    {
        if (!(*itor)->IsLifeEnd())
            (*itor)->Init();
    }

    EnemyBase::SetPause(false);

    mCurrentStage++;
    LoadMap();
    MciSound::_PlaySound(S_START);
    CutStage();
    ShowStage();
}
```

如果失败，就把当前关卡重置为第一关，并显示大 GameOver：

```cpp
mCurrentStage = 1;
mShowGameOverAfterScorePanel = true;
MciSound::_PlaySound(S_FAIL);
```

这套状态流转可以总结为：

```text
游戏中
  -> 胜利：杀满 20 个敌人 -> 分数面板 -> 下一关
  -> 失败：大本营毁坏或玩家全灭 -> GameOver -> 回到选择/初始流程
```

## 自定义地图：直接编辑运行时标记

`CreateMap()` 是一个简单地图编辑器入口。它用方向键移动光标坦克，用 `J` 和 `K` 切换地形组合，用回车确认。

地形组合存在 `sign_order` 中：

```cpp
int sign_order[14][4] = {
    {_ICE, _ICE, _ICE, _ICE},
    {_FOREST, _FOREST, _FOREST, _FOREST},
    {_RIVER, _RIVER, _RIVER, _RIVER},
    {_STONE, _STONE, _STONE, _STONE},
    ...
    {_EMPTY, _EMPTY, _EMPTY, _EMPTY}
};
```

每次选择一种地形组合，就写入当前 16x16 区域对应的四个 8x8 格子：

```cpp
i = mCMTImageY / BOX_SIZE - 1;
j = mCMTImageX / BOX_SIZE - 1;

mBoxMarkStruct->box_8[i][j] = sign_order[cur_index][0];
mBoxMarkStruct->box_8[i][j + 1] = sign_order[cur_index][1];
mBoxMarkStruct->box_8[i + 1][j] = sign_order[cur_index][2];
mBoxMarkStruct->box_8[i + 1][j + 1] = sign_order[cur_index][3];
```

确认时再同步到 `box_4`，并清理敌人出生点和玩家/大本营位置：

```cpp
if (mBoxMarkStruct->box_8[i][j] != _EMPTY &&
    mBoxMarkStruct->box_8[i][j] != CAMP_SIGN)
    SignBox_4(i, j, mBoxMarkStruct->box_8[i][j]);

if (i <= 1 && j <= 1 || j >= 12 && j <= 13 && i <= 1 || j >= 24 && i <= 1)
{
    mBoxMarkStruct->box_8[i][j] = _EMPTY;
    SignBox_4(i, j, _EMPTY);
}
```

这说明自定义地图并不是重新生成文件，而是直接修改当前 `BoxMarkStruct`。它可以立即进入游戏，但如果想长期保存，需要额外设计写文件逻辑。

## 这份实现的优点和可以改进的地方

从课程项目或答辩角度看，这份代码有几个值得肯定的设计。

它使用固定逻辑画布和整体拉伸，避免了坐标系统混乱；使用 `BoxMarkStruct` 统一承载地图、坦克、子弹和道具标记，让碰撞检测不需要遍历所有对象；使用 `TimeClock` 分别控制移动、子弹、爆炸和状态持续时间，使不同元素可以有不同节奏；玩家、敌人和控制器职责基本分开，玩家不直接管理敌人链表，敌人也不直接管理关卡状态。

但它也有一些边界和风险，讲解时最好主动说明。

首先，内存管理大量使用裸指针和 `new/delete`，例如 `PlayerList` 和 `EnemyList` 存储对象指针。现代 C++ 可以用 `std::unique_ptr` 降低泄漏和重复释放风险。

其次，部分对象死亡后不会马上从链表移除，而是靠 `mDied` 和爆炸状态跳过逻辑。这种写法能保留爆炸动画，但需要非常小心所有循环都检查死亡状态，否则可能出现已死亡对象继续参与逻辑的问题。

再次，碰撞检测是离散格子检测，速度不能随意调高。子弹速度注释里已经写明每次移动不能超过 4 像素，否则可能跨过 4x4 检测格。这是实现选择带来的限制，不是 EasyX 本身的限制。

最后，项目使用 `GetAsyncKeyState` 直接轮询键盘状态，适合简单游戏，但对复杂输入、键盘冲突、键位配置和输入事件记录支持有限。如果要扩展成更完整的游戏，可以设计输入管理层，把“当前按键状态”和“本帧按下事件”分开。

## 讲解时可以抓住的几个问题

如果队友需要上台讲源码，可以围绕这些问题组织回答。

为什么不直接画到窗口？因为项目使用固定逻辑分辨率，先把所有元素画到 `256 x 224` 画布，再拉伸到 `512 x 448` 窗口。这样坐标、地图和碰撞都保持低分辨率像素风规则。

为什么有 `box_8` 和 `box_4` 两套地图？`box_8` 适合地图块和通行判断，`box_4` 适合坦克占位、子弹弹头和砖墙局部破坏。两套标记共同保证移动和射击都能检测。

双人键盘冲突怎么解决？同一玩家的方向键用 `else if` 保证一次只处理一个方向；发射键单独 `if`，所以移动和开火可以同时发生；两个玩家使用不同键位，并通过两个 `PlayerBase` 实例隔离状态；共享格子标记防止实体重叠。

子弹互相击中为什么需要 `WAIT_UNSIGN`？因为子弹是逐个处理的。如果第一颗子弹直接清空格子，第二颗可能检测不到碰撞。中间状态让双方都能处理到这次互撞。

为什么坦克转向时要调整坐标？因为坦克和地图都基于格子检测。转向前把中心点对齐到格子线，可以避免坦克卡在半格位置造成碰撞误差。

森林为什么最后画？因为森林在原版中会遮住坦克。绘制顺序就是图层顺序，后画的森林会盖住先画的坦克。

胜利和失败如何判断？击杀 20 个敌人触发胜利；大本营被击中或所有玩家生命耗尽触发失败；之后统一进入分数面板或 GameOver 动画。

## 如果按“从零写一遍”来讲

真正上台讲源码时，不建议一开始就打开 `PlayerBase.cpp` 的长函数。更稳的讲法是把项目当成逐步搭建出来的游戏。

先讲窗口和画布。第一步创建 `512 x 448` 窗口，但所有游戏逻辑都按 `256 x 224` 画布计算，中间战场是 `208 x 208`。这样能解释为什么项目里到处是 `WINDOW_WIDTH`、`CANVAS_WIDTH`、`CENTER_WIDTH`，也能自然引出 `BitBlt` 和 `StretchBlt`。

再讲主控制器。第二步创建 `GameControl`，让它持有玩家链表、敌人链表和地图标记。这里要强调：玩家和敌人不是散落在 `main` 里，而是统一交给控制器管理，所以关卡切换、胜负判断和结算面板都能集中处理。

然后讲共享地图。第三步设计 `BoxMarkStruct`，用 `box_8` 管地图块，用 `box_4` 管坦克和局部破坏，用 `prop_8` 管道具，用 `bullet_4` 管子弹。讲到这里，老师如果追问碰撞检测，基本都可以从这张表回答。

接着讲玩家。第四步写 `PlayerBase`，先处理键盘输入，再处理移动，再把玩家占用写进 `box_4`。双人模式不是写两套玩家代码，而是同一个类创建两个对象，通过 `player_id` 使用不同键位和不同初始位置。

之后讲子弹。第五步给玩家加子弹槽，按方向生成子弹，飞行时写入 `bullet_4`，碰撞时检查墙、敌人、玩家和大本营。子弹互撞时引入 `WAIT_UNSIGN`，解释顺序处理带来的中间状态。

再讲敌人。第六步写 `EnemyBase`，让敌人先显示四角星、占位成功后出现，再按随机方向移动和发射。普通坦克、道具坦克和大型坦克通过继承扩展绘制和血量规则。

最后讲关卡。第七步把击杀数量、玩家生命、大本营状态、分数面板和下一关加载接起来。到这里，一个“从零搭出来”的坦克大战就完整了：画布能显示，地图能阻挡，玩家能移动，敌人能生成，子弹能碰撞，胜负能收束。

这条讲解路线的好处是，听的人不需要先记住每个函数名。函数名会在机制中自然出现：讲画布时出现 `StartGame()` 的合成代码，讲地图时出现 `InitSignBox()`，讲移动时出现 `Move()` 和 `CheckMoveable()`，讲子弹时出现 `CheckBomb()`，讲胜负时出现 `IsWinOver()` 和 `IsGameOver()`。源码讲解就会从“背函数”变成“解释为什么要有这些函数”。

## 回到源码主线

把这些机制放回完整流程里看，FC-Tank 的实现并不是简单的“按键改变坐标、图片跟着移动”。它真正维护的是一张共享的运行时格子地图：玩家、敌人、子弹、墙体、道具和大本营都通过这张地图发生关系。渲染层按固定画布合成画面，输入层更新玩家意图，实体层更新位置和子弹，控制层判断胜负和关卡推进。

理解这张共享地图之后，图形展示、双人合作、碰撞检测、子弹互撞、砖墙破坏和关卡状态就不再是分散的代码片段，而是同一个设计下的不同表现。
