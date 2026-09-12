# iOS 离线 / 恢复联网验收流程(模拟器,四个时点)

这份文档记录**怎么在 macOS 的 iOS 模拟器上,验收「离线时界面画什么」和「恢复联网后会不会自己回来」**。
和 [iOS 性能测量基线](ios-perf-baseline.md) 并列 —— 那份管性能数字怎么采,这份管离线 / 恢复怎么造、怎么计时、怎么拍。

**动手之前先读 §3。** 最直觉的断网手法(用 `networksetup` 开关系统代理)会得到**假 FAIL**,
而且失败现象和「功能真坏了」一模一样。这不是理论风险,是实测踩出来的(§3)。

适用范围:任何「离线空态 / 断线提示 / 恢复联网自动重连」类的 iOS 改动,典型就是
「请求失败被画成数据为空」那一族(任务 34NPir5jTt25Lk5VVcZEW 的验收流程)。

---

## 0. 速查

| 步骤 | 一句话 | 细节 |
| --- | --- | --- |
| 构建 | 默认签名 + 显式 `DEVELOPER_DIR` | §1 |
| 登录 | 由所有者手动登一次,之后反复覆盖安装不用再登 | §1.4 |
| 断网 | 系统代理**全程固定**指向 `127.0.0.1:18080`,靠 CONNECT 代理进程的**启停**切换离线 / 在线 | §2 |
| ❌ 不要 | 用 `networksetup` 开关代理来制造断网和恢复 | §3 |
| 计时 | Appium `autoLaunch=false`,时钟交给 `simctl launch` | §5.1 |
| 收尾 | 代理关掉、bypass 还原、代理进程杀掉 | §6 |

---

## 1. 构建与安装

### 1.1 `DEVELOPER_DIR` 必须显式设

Mac mini 那台机器的 `xcode-select` 指向 CommandLineTools,`xcodebuild` / `xcrun simctl` 直接跑会报错。
不要 `sudo xcode-select -s`(会改动整机状态),加环境变量即可:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

### 1.2 必须用默认签名,**不要**加 `CODE_SIGNING_ALLOWED=NO`

`CODE_SIGNING_ALLOWED=NO` 产出的是 linker-signed 包,**存不进 Keychain**:登录后 token 写不进去,
下一次读取失败,app 立刻被踢回登录页 —— 整个验收就没法做。

装完用这个确认(判据是 `flags=0x2(adhoc)` 且 `Sealed Resources version=2`):

```bash
codesign -dv --verbose=4 /tmp/orbit-dd/Build/Products/Debug-iphonesimulator/Orbit.app
```

- ✅ 可用:`flags=0x2(adhoc)` + `Sealed Resources version=2`
- ❌ 不可用:`flags=0x20002(adhoc,linker-signed)`

### 1.3 构建与安装

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
S=5DC6920A-2A6D-45BA-84E4-EAAD1A637CD6      # iPhone 17 Pro / iOS 26.5

cd src/ios && xcodegen generate
xcodebuild -scheme Orbit -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/orbit-dd build
xcrun simctl install "$S" /tmp/orbit-dd/Build/Products/Debug-iphonesimulator/Orbit.app
```

模拟器机型 / UDID 换了要在验收评论里注明 —— 不同机型的点击坐标不一样(§5.2 的 `DRAWER_OPEN` 等坐标
是 iPhone 17 Pro 点位,换了机器要重新从 accessibility tree 里量)。

### 1.4 登录

**钥匙串按模拟器持久化,手动登一次之后反复冷启不用再登。**

- 如果模拟器里已经是登录态,默认签名的覆盖安装**会保留**它 —— 这是期望情况,不要输任何账号。
- 如果装完落到登录页,**停下,请所有者手动登录一次**,不要自己输账号。

---

## 2. 断网:固定端口 + 本地 CONNECT 正向代理

### 2.1 原理

分两件事,必须分开:

| | 谁来做 | 在整次运行中 |
| --- | --- | --- |
| **代理地址** | macOS 系统代理设置(`networksetup`) | **设一次,全程不动** |
| **通不通** | 端口 `127.0.0.1:18080` 上那个 CONNECT 代理进程的死活 | 随四时点开关 |

- **离线** = 代理进程没在跑 → app 连 `127.0.0.1:18080` 得到 **ECONNREFUSED**(连接被拒)
- **在线** = 代理进程在监听 → 连接被接受,真实转发

关键在**地址恒定**:app 启动时读到的代理配置从第一秒到最后都是同一个值,所以不存在「配置变了但进程不知道」
这种假象。而「端口上有没有人监听」是 TCP 栈**每次连接时现场判定**的,一个已经在跑的进程不需要重新读配置
就能感知到恢复 —— 这正是「恢复联网」要模拟的真实信号。

> 顺带:这也是为什么它测得了「原地恢复」。代理进程重新起来的那一刻,app 下一次重试就会成功,
> 不需要重启 app、不需要改任何系统设置。

### 2.2 固定系统代理(设一次,全程不动)

先找出**实际在用的网络服务名**,并**保存原值**:

```bash
SERVICE=Ethernet                              # networksetup -listallnetworkservices 里确认
networksetup -getwebproxy             "$SERVICE" > /tmp/iosverify.webproxy.orig
networksetup -getsecurewebproxy       "$SERVICE" > /tmp/iosverify.secure.orig
networksetup -getproxybypassdomains   "$SERVICE" > /tmp/iosverify.bypass.orig
```

**在 app 启动之前**把 HTTP 与 HTTPS 代理都钉到 `127.0.0.1:18080`,并把 loopback 加进 bypass:

```bash
networksetup -setwebproxy        "$SERVICE" 127.0.0.1 18080
networksetup -setsecurewebproxy  "$SERVICE" 127.0.0.1 18080
networksetup -setproxybypassdomains "$SERVICE" "*.local" "169.254/16" "localhost" "127.0.0.1"
```

两点实测到的行为,别被绕进去:

- **`-setwebproxy` 会顺带把 Enabled 置回 Yes**,不需要再单独 `-setwebproxystate on`(实测:
  设完立刻 `Enabled: Yes` / `Server: 127.0.0.1` / `Port: 18080`)。见 §6 反过来用时的那个坑。
- bypass 里的 `localhost` 和 `127.0.0.1` 是**给验收脚本自己用的**(§4.1)。**原值如果是
  `*.local  169.254/16`(这台机器的原值就是),收尾要改回去**,不要留成四条的版本。

### 2.3 CONNECT 代理进程(参考实现)

一个最小可用的 HTTP `CONNECT` 正向代理就够 —— HTTPS 走 `CONNECT`,HTTP 也由 CFNetwork 走同一入口。
下面是 Mac mini 上实测跑通的那份,可直接抄:

```python
"""Minimal HTTP CONNECT forward proxy (127.0.0.1:18080)."""
import socket, sys, threading

HOST, PORT = "127.0.0.1", 18080

def copy(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass

def handle(conn):
    upstream = None
    try:
        conn.settimeout(30)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
            if len(buf) > 65536:
                return
        request_line = buf.split(b"\r\n", 1)[0].decode("latin-1")
        parts = request_line.split()
        if len(parts) < 3 or parts[0].upper() != "CONNECT":
            conn.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        host, _, port = parts[1].rpartition(":")
        upstream = socket.create_connection((host, int(port)), timeout=15)
        upstream.settimeout(None)
        conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        conn.settimeout(None)
        threading.Thread(target=copy, args=(upstream, conn), daemon=True).start()
        copy(conn, upstream)
    except Exception as e:
        print(f"proxy handler: {e}", file=sys.stderr, flush=True)
    finally:
        for s in (conn, upstream):
            if s is not None:
                try:
                    s.close()
                except Exception:
                    pass

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(256)
    print(f"listening on {HOST}:{PORT}", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

main()
```

### 2.4 离线 / 在线 = 进程死活

```python
def port_open(port=18080):
    s = socket.socket(); s.settimeout(1)
    try:
        s.connect(("127.0.0.1", port)); return True
    except Exception:
        return False
    finally:
        s.close()

def proxy_up():                       # 在线
    if port_open():
        return
    subprocess.Popen(["python3", "connect_proxy.py"], stdout=open("proxy.log", "ab"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(40):
        time.sleep(0.25)
        if port_open():
            return
    raise RuntimeError("proxy did not come up")

def proxy_down():                     # 离线
    subprocess.run(["pkill", "-f", "connect_proxy.py"], capture_output=True)
    for _ in range(40):
        time.sleep(0.25)
        if not port_open():
            return
    raise RuntimeError("proxy did not stop")
```

**每次切换后都要用端口探测确认真的切过去了**,不要假设 `pkill` 立刻生效 —— 收敛等待是上面那段循环的全部意义。

---

## 3. 为什么**不能**用 `networksetup` 开关代理(实测反面教材)

> ⚠️ **这一节是本文档存在的主要原因。** 下面这个手法看起来更简单,但它对「恢复联网」这个时点
> **必然给出假 FAIL**,而且失败的样子和「功能真坏了」无法区分。

### 3.1 旧手法

把 macOS 系统 HTTP/HTTPS 代理临时指向**本机 9 端口**(`127.0.0.1` 上一个没人监听的端口,当黑洞用),
测完用 `trap` 把原值还原;「恢复联网」= 把代理状态关掉。

### 3.2 实测故障

验收会话在任务 34NPir5jTt25Lk5VVcZEW 上实测到:**把 `networksetup` 代理关掉之后 49 秒,
以及 2 分 42 秒,被测 app 仍然在向本机 9 端口发起连接。**

- 日志:`_NSURLErrorNWPathKey=satisfied (Path is satisfied), interface: en0, proxy`
- 重试循环明显还活着:URLSession task id 已经递增到 `.<75>`

也就是说,**「关掉代理」这个动作对那个已经在跑的 app 完全不起作用。**

### 3.3 成因:CFNetwork 对**已运行进程**保留它启动时读到的代理配置

CFNetwork 拿到代理字典之后会缓存住,`networksetup` 改的是 SystemConfiguration 里的持久化设置,
**它到不了一个已经跑起来的进程**。只要 app 是在「代理指向 9 端口」时启动的,它就会一直往那儿连,
一直连不上,直到进程重启。

旁证 —— `networksetup -setwebproxystate <service> off` 之后,配置里其实**还留着那个黑洞地址**
(实测于 `/Users/long/orbit-verify/run_offline.log`):

```
[+  49.1s] proxy OFF web=Enabled: No Server: 127.0.0.1 Port: 9 Authenticated Proxy Enabled: 0
```

`Enabled: No` 只是不再对**新**进程生效,`Server` 字段仍原样留着。

### 3.4 后果

「恢复联网后 30s / 90s 自动恢复」这两个时点**永远等不到联网** —— app 还在按老配置连一个死端口。
于是一个**正确的修复会被判成 FAIL**,且现象(界面一直停在错误态)和「功能真坏了」一模一样。

这不是推测:任务 34NGJFWxAnWMq5i1fZMre 里那条「恢复联网后 30s / 90s 仍停在 Runners」的基线结论,
事后就是**因为用了这个手法被撤回的**(见该任务的更正评论)。基线如此,验收同样会如此。

**所以:不要把「指向 9 端口 + 开关代理」写成可行做法。** 本机 9 端口在那个手法里只能当**黑洞目标**,
永远不能当代理端口 —— 见 §4.2。要造断网,用 §2 的固定端口 + 进程启停。

---

## 4. 配套坑

### 4.1 代理开着时,验收脚本自己的 loopback 调用会被劫持

系统代理一开,**脚本自己**对 `127.0.0.1` 的调用也会被 CFNetwork / urllib 送进代理。两个后果:
Appium 的 WebDriver 请求会莫名变慢或失败;更隐蔽的是 Python 侧 —— `urllib` 会通过
`urllib.getproxies()` 去读 SystemConfiguration,于是 `http://127.0.0.1:4725/...` 也被塞给代理。

两层防护都要做:

1. **Python:显式绕开。** 自己建一个禁用代理的 opener,不要用 `urllib.request.urlopen`:
   ```python
   _OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
   # 之后用 _OPENER.open(req, timeout=...) 代替 urlopen
   ```
2. **系统侧:把 loopback 加进 bypass domains**(§2.2 的 `localhost` 与 `127.0.0.1`)。
3. 用 `curl` 手工排查时记得 `--noproxy '*'`。

### 4.2 端口 <1024 普通用户**绑不上**,只能当黑洞目标

实测(非 root,uid 501)在 `127.0.0.1` 上各自 bind 一次:

| 绑定目标 | 结果 |
| --- | --- |
| 9 端口 | `PermissionError: [Errno 13] Permission denied` |
| 18080 端口 | 成功 |

所以 9 端口这类低位端口**不可能**当代理端口 —— 这正是旧手法让它当「黑洞」的原因。选代理端口时
用高位端口(`18080` 是参考实现用的那个),并且**不要**为了迁就它去 `sudo`。

### 4.3 抓 app 日志

按四时点拍截图之外,想拿连接层的证据就跟着 app 看日志:

```bash
xcrun simctl spawn <UDID> log stream --predicate 'process == "Orbit"' > app.log
```

离线时 `com.apple.network:connection` / `com.apple.CFNetwork` 子系统里会看到对代理地址的连接尝试;
恢复后同一子系统的 task 会 `received response, status 200`。**这是旁证,不能替代截图**
(§5.2 的时点判定仍以画面为准)。

---

## 5. 四个时点怎么跑

### 5.1 计时口径:时钟交给 `simctl launch`

**Appium 的 XCUITest 驱动点击时用 `autoLaunch=false`** —— 否则是 WDA 替我们把 app 拉起来的,
`xcrun simctl launch` 的时刻就不等于进程启动时刻,20s / 30s / 90s 全部失去意义。

```python
sid = A.new_session(auto_launch=False, port=8104)   # 只建会话,不启动 app
...
t_launch = time.time()          # 紧跟这一行之后
A.launch_app()                  # = xcrun simctl launch <UDID> io.orbitd.app
```

**20s / 30s / 90s 一律从 app 进程启动那一刻起算**,不是从 WDA 启动起算、也不是从「画面出现」起算。
`terminate_app()` / `launch_app()` 都走 `simctl`,和上面同一个时钟。

### 5.2 序列

参考实现在 `/Users/long/orbit-verify/run_full.py`,完整时间线见 `run_full.log`。要点:

**序列 A —— 离线冷启动 → 恢复 → 重启**

| # | 动作 | 时点 |
| --- | --- | --- |
| A1 | 离线冷启动 | **20s**:主画面 |
| A2 | 点开 drawer(坐标 `(38, 84)`) | 20s 之后 |
| A3 | 关掉 drawer(坐标 `(343, 84)`) | — |
| A4 | **不做任何点击**,代理进程起来 | **30s**(从代理恢复起算) |
| A5 | 同上,仍然不做任何操作 | **90s** |
| A6 | `simctl terminate` + `launch`,联网状态 | 15s |

**序列 B —— Settings → Runners,离线一次、恢复后一次**

| # | 动作 | 时点 |
| --- | --- | --- |
| B1 | 离线冷启动后进 Settings(齿轮坐标 `(273, 810)`) | 20s |
| B2 | 切到 Runners 行(坐标 `(100, 195)`) | — |
| B3 | 代理进程起来,**不做任何操作** | **30s** |
| B4 | 同上 | **60s** |

两点纪律:

- **A4/A5 期间绝对不能点击、不能重启进程。** 这个时点考的就是「自己回来」;碰一下屏幕就把证据毁了。
- 坐标是 iPhone 17 Pro 的点位,换了机型要重新从 accessibility tree 里量。点之前先 dump 一次可见元素
  (`appium.py` 里的 `dump_labels`),别硬抄。

### 5.3 怎么判断截到的不是旧画面

联网恢复后的画面必须**含只可能来自服务端的数据**(会话列表内容、runner 的版本号 / 数量),
否则可能只是缓存的旧帧。参考验收里就是拿 runner 版本号(`v0.1.155` / `v0.1.156`)和会话列表当旁证的。
另外,**同一时点连拍两张比 md5** —— 一致说明画面稳定、没有闪回。

---

## 6. 收尾还原

**先把代理进程停掉,再关系统代理**,顺序反了会有一段「代理开着但没人转发」的窗口。

```bash
SERVICE=Ethernet

pkill -f connect_proxy.py

networksetup -setwebproxystate       "$SERVICE" off
networksetup -setsecurewebproxystate "$SERVICE" off
networksetup -setproxybypassdomains  "$SERVICE" "*.local" "169.254/16"   # 按 /tmp/iosverify.bypass.orig 的原值
```

> ⚠️ **一个反直觉的坑(实测):`networksetup -setwebproxy "$SERVICE" "" 0` 会把 `Enabled` 置回 `Yes`。**
> 想顺手把 `Server` 字段清空的话,**清完之后必须再关一次**:

```bash
networksetup -setwebproxy "$SERVICE" "" 0
networksetup -setwebproxystate "$SERVICE" off      # ← 少这一行,代理就一直是开的
```

**还原后逐项核对**,和 `/tmp/iosverify.*.orig` 对得上才算完:

```bash
networksetup -getwebproxy "$SERVICE"          # 期望 Enabled: No / Server: 空 / Port: 0
networksetup -getsecurewebproxy "$SERVICE"    # 同上
networksetup -getproxybypassdomains "$SERVICE"
```

这台机器的还原目标是:

```
Enabled: No
Server:
Port: 0
Authenticated Proxy Enabled: 0

*.local
169.254/16
```

---

## 7. 参考实现与产物

这些东西在 **Mac mini 上,不在仓库里**(属于一次性验收脚手架,不进产品代码路径):

| 路径 | 内容 |
| --- | --- |
| `/Users/long/orbit-verify/connect_proxy.py` | §2.3 的 CONNECT 正向代理 |
| `/Users/long/orbit-verify/run_full.py` | §5.2 的四时点序列(含全套坐标与代理启停) |
| `/Users/long/orbit-verify/run_full.log` | 一次完整跑通的时间线 |
| `/Users/long/orbit-verify/appium.py` | 无依赖的 Appium/WebDriver 客户端(`autoLaunch=false`、`ProxyHandler({})`、`simctl` 封装都在这里) |
| `/Users/long/orbit-shots-fix/` | 参考验收的截图产物(A1–A6 / B1–B4)。同目录下 `00-*`、`01-06`、`10-14`、`20`、`21`、`90-94` 是**更早的废弃批次,不要用来判读** —— 其中一批就是 §3 那个假 FAIL 的产物 |

参考验收的完整结论与逐条对照,在任务 34NPir5jTt25Lk5VVcZEW 的评论里。
