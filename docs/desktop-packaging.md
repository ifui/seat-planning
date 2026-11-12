# 桌面端打包（Tauri v1）

> 实测环境：Windows 11 x64（本机），Rust **1.77.2**、Tauri 1.8.3、@tauri-apps/cli 1.6.x。
> 本文所有体积、退出码、CDP 结论均为本机本轮实测；无法在本机验证的项目会明确标注。

---

## 1. 命令与产物

```bash
npm install
npm run desktop:dev      # tauri dev，前端 5173 + 原生窗口
npm run desktop:build    # 类型检查 + 构建单文件 dist + 出安装包
```

产物（`src-tauri/target/release/bundle/`）：

| 文件 | 实测体积 |
|---|---|
| `msi/座位编排_0.1.0_x64_zh-CN.msi` | **3,194,880 字节 ≈ 3.05 MB** |
| `nsis/座位编排_0.1.0_x64-setup.exe` | **2,399,146 字节 ≈ 2.29 MB** |
| 安装后主程序 `座位编排.exe` | 6,127,104 字节 ≈ 5.84 MB |

对比：上一版用 `offlineInstaller` 时为 **MSI 208.3 MB / EXE 210 MB**。体积差全部来自内嵌的 WebView2 完整运行时，与应用代码无关。

## 2. WebView2 分发模式与体积

`src-tauri/tauri.conf.json` 的 `tauri.bundle.windows.webviewInstallMode` 决定安装包如何获得 WebView2 运行时：

| 模式 | 打包增量 | 安装时联网 | 说明 |
|---|---|---|---|
| `skip` | 0 | 否 | 假定目标机已有可用运行时，不检查不安装 |
| **`downloadBootstrapper`（当前配置）** | 0 | **是（仅当缺少运行时）** | 安装时先检查本机运行时，缺失才下载约 1.8 MB 的引导程序再装 Evergreen 运行时 |
| `embedBootstrapper` | 约 +1.8 MB | 是（仅当缺少运行时） | 引导程序进安装包，省一次下载，但运行时本体仍要联网 |
| `offlineInstaller` | 约 +127 MB | 否 | 内嵌完整离线运行时（就是 208 MB 的来源） |
| `fixedRuntime` | 约 +180 MB | 否 | 内嵌指定版本运行时（Win7 固定 109 时的打包选项） |

### 2.1 当前模式（downloadBootstrapper）的代价

- **默认假定目标机已有 WebView2**：Windows 11 自带；Windows 10 只要装过/更新过 Edge 就有；但 **LTSC、精简版、部分 Server 版、长期不联网的机器可能没有，或版本过低**。
- **没有或版本过低时会联网下载**：安装器会从微软下载 Evergreen 引导程序并安装运行时。目标机离线且没有运行时时，**安装会失败**（安装器报下载错误），不会静默降级。
- **Win7/8.1 不能走这条路装最新运行时**：最新 Evergreen 已不支持 Win7，必须预装 109，见第 3 节。

### 2.2 离线目标机的处理（不默认打包）

推荐：**运行时安装包单独分发**，不塞进应用安装包。

1. 从微软官方页面下载 Evergreen Standalone Installer（x64）：
   <https://developer.microsoft.com/microsoft-edge/webview2/> → *Evergreen Standalone Installer* → `MicrosoftEdgeWebView2RuntimeInstallerX64.exe`。
2. 在目标机静默安装：

   ```bat
   MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install
   ```

3. 校验是否已装（存在 `pv` 值即已安装）：

   ```bat
   reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv
   ```

   也可用 `HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{...}`（64 位视图）。

如果确实需要「一个安装包解决离线机器」，再把 `webviewInstallMode` 临时改为：

```json
{ "type": "offlineInstaller", "silent": true }
```

代价是安装包回到 200 MB 量级，**本项目不这么做**，仅作为应急选项记录。

## 3. Windows 7 支持

### 3.1 工具链锁定 1.77.2

Rust 1.78 起 MSVC 目标的最低系统要求提升到 Windows 10，**1.77.2 是最后一个支持 Win7/8 的正式版**。

`rust-toolchain.toml`：

```toml
[toolchain]
channel = "1.77.2"
```

国内网络下清华 / 阿里云 / USTC 镜像缺 1.77.x，用 rsproxy：

```powershell
$env:RUSTUP_DIST_SERVER='https://rsproxy.cn'
rustup toolchain install 1.77.2
```

**本机实测结论**：在 1.77.2 下 `cargo build --release` 与 `npm run desktop:build` 均成功（release 编译约 1 分 33 秒，打包 2 个 bundle 正常结束）。`src-tauri/src/main.rs` 只用了 `std::fs` / `std::process` / `Mutex` 等基础 API，没有 1.78+ 才有的接口。

### 3.2 为兼容 1.77.2 而降级的依赖

`Cargo.lock` 已用 1.77.2 重新生成（**lockfile version 3**，v4 只有 ≥1.78 的 cargo 能读）。直接依赖版本未变，被固定的是传递依赖：

| crate | 从 | 到 | 原因 |
|---|---|---|---|
| `url` / `idna` | 2.5.8 / 1.1.0 | 2.5.0 / 0.5.0 | 新版 `idna` 拉入 `icu_* 2.4`（edition 2024） |
| `indexmap` / `hashbrown` | 2.14.2 / 0.17.1 | 2.7.1 / 0.15.5 | `hashbrown 0.17` 是 edition 2024 |
| `plist` / `quick-xml` | 1.10.3 / 0.42.0 | 1.7.0 / 0.32.0 | 新版 `plist` 要求 `indexmap ^2.14` |
| `serde_with` | 3.24.0 | 3.8.1 | 3.24 要求 `time ~0.3.47`，新 `time` 是 edition 2024 |
| `time` / `deranged` / `powerfmt` | 0.3.55 / 0.5.9 / 0.2.1 | 0.3.36 / 0.3.11 / 0.2.0 | edition 2024 / MSRV 1.79 |
| `tokio` | 1.54.1 | 1.39.3 | MSRV 1.85 |
| `uuid` | 1.29.2 | 1.11.0 | 依赖 `getrandom 0.4`（edition 2024） |
| `tempfile` | 3.27.0 | 3.14.0 | 依赖 `getrandom 0.4`（edition 2024） |
| `getrandom` | 0.4.3 | 0.2.x（0.4 已移除） | edition 2024 |
| `ignore` / `globset` | 0.4.34 / 0.4.21 | 0.4.23 / 0.4.15 | edition 2024 |
| `encoding_rs` | 0.8.44 | 0.8.35 | edition 2024 |
| `unicode-segmentation` | 1.13.3 | 1.12.0 | MSRV 1.85 |
| `chrono` | 0.4.45 | 0.4.38 | 新版依赖 `windows-core 0.62`（MSRV 1.82） |
| `iana-time-zone` / `windows-core` | 0.1.65 / 0.62.2 | 0.1.60 / 0.52.0 | MSRV 1.82 |

这些都是传递依赖，接口没变，应用功能不受影响。**以后升级依赖时**：用 1.77.2 重新解析（`cargo +1.77.2 generate-lockfile` 或在该工具链下 `cargo update`），否则新解析出的 edition 2024 crate 会让 Win7 兼容构建直接失败。

### 3.3 Win7 上的 WebView2：必须 109

WebView2 运行时 **109 是最后一个支持 Windows 7 / 8 / 8.1 的版本**，更高版本在 Win7 上装不上也不受支持。二选一：

**方案 A（推荐）：预装 WebView2 109**

1. 取得 109 的离线运行时安装包（微软 *WebView2 Runtime 109* 的 Evergreen Standalone Installer，或 Fixed Version 的 109 `.cab`）。
2. 在 Win7 机器上先装运行时，再装应用：

   ```bat
   MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install
   ```

3. 应用安装包保持 `downloadBootstrapper` 即可：安装器检测到本机已有运行时就不会联网。**若没预装 109，安装器会去下载最新 Evergreen，而最新版不支持 Win7，安装会失败。**

**方案 B：固定运行时（fixed runtime）**

1. 下载 109 的 Fixed Version `.cab`，解压到固定目录，例如 `C:\Program Files\座位编排\WebView2-109\`（目录内应直接看到 `msedgewebview2.exe`）。
2. 启动应用前设置环境变量，指向该目录：

   ```bat
   set WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=C:\Program Files\座位编排\WebView2-109
   ```

   通过快捷方式 / 启动脚本设置，或用 `setx` 写入用户环境变量。Tauri 1.8.3 在创建 WebView 时会读取该变量。
3. 这种部署方式下把 `webviewInstallMode` 改为 `{ "type": "skip" }`，避免安装器再做运行时检测/下载。

**不建议**在打包时用 `{ "type": "fixedRuntime", "path": "..." }`：它会把运行时内嵌进安装包（约 +180 MB），与本轮「回到几 MB」的目标冲突。

### 3.4 Win7 机器还需要准备什么

| 项目 | 是否必需 | 说明 / 安装方式 |
|---|---|---|
| Windows 7 **SP1** | 必需 | RTM 不支持 |
| **WebView2 运行时 109** | 必需 | 见 3.3；109 之后的版本不支持 Win7 |
| **VC++ 2015–2022 运行库（x64）** | 必需 | Rust MSVC 产物依赖 `vcruntime140.dll` / `msvcp140.dll`；`vc_redist.x64.exe /install /quiet /norestart` |
| **UCRT（KB2999226）** | 通常必需 | 系统缺 `ucrtbase.dll` 时装不了 VC++ 运行库；随 VC++ 安装包会提示 |
| **SHA-2 代码签名支持（KB4474419）** | 必需 | WebView2 109 与多数现代安装包都要求；缺了会报签名/安装错误 |
| **TLS 1.2（KB3140245）** | 视情况 | 只有需要联网下载运行时/更新时才需要 |
| 管理员权限 | 装运行时/VC++ 时需要 | 应用本身按用户目录安装，不需要管理员 |

### 3.5 无法真机验证的部分（如实说明）

- 本机只有 Windows 11，**没有 Win7 机器**。已验证的是：1.77.2 工具链能编译出 x64 产物、依赖层面没有 1.78+ 的 crate、安装包能安装/卸载/启动。
- **未验证**：Win7 实机上的启动、WebView2 109 的渲染与 IndexedDB/SQLite 行为、KB 补丁缺失时的具体报错。这些需要在 Win7 SP1 机器上跑一次冒烟测试才能下定论。

## 4. 代码签名

- 当前产物**未签名**，`Get-AuthenticodeSignature` 对 MSI 与 EXE 均返回 `NotSigned`。
- 安装包**可以正常安装**：本轮用 NSIS 静默安装到自定义目录，安装器退出码 0，主程序启动后 CDP 探测到页面 `座位编排系统`（`https://tauri.localhost/`），随后静默卸载退出码 0、目录清空。
- 未签名的影响：Windows SmartScreen 首次运行会提示「未知发布者」，需要用户点「更多信息 → 仍要运行」；企业环境可能被策略拦截。这是不签名的既定代价。
- CI 里**没有**签名步骤，未配置任何证书也能出包。以后要签名再加 `bundle.windows.certificateThumbprint` 并在 CI 注入证书，不属于本轮范围。

## 5. 应用图标

项目里没有 `public/`、`src/assets/`，`index.html` 也没有 favicon；唯一的品牌图形是侧栏的 CSS 徽标 `.brand-mark`（[src/style.css](../src/style.css) 第 77–102 行）：**32px 圆角方块、主色 `--primary: #4a7c7b`（青绿）、白色左下 L 形坐标轴、右上 4px 白点**。

因此按这个造型重绘了矢量源并生成全套图标（没有沿用旧的脚本占位图）：

```bash
# 1) 矢量源：src-tauri/app-icon.svg（圆角方块 + 白色 L 轴 + 右上白点）
# 2) 1024×1024 透明背景 PNG：src-tauri/app-icon.png
# 3) 全套平台图标
npx tauri icon src-tauri/app-icon.png -o src-tauri/icons
```

产物：`icon.ico`（6 帧：16/24/32/48/64/256）、`icon.icns`（83,905 B）、`32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`（256）、`icon.png`（512）、`Square*Logo.png`、`StoreLogo.png`；1024 源图另存为 `src-tauri/app-icon.png`。`tauri.conf.json` 的 `bundle.icon` 已指向这些文件。

## 6. CI（.github/workflows/build.yml）

| job | 工具链 | 说明 |
|---|---|---|
| `build-windows-x64` | stable（`RUSTUP_TOOLCHAIN: stable` 覆盖 rust-toolchain.toml） | Win10/11 包 |
| `build-windows-x64-win7` | **1.77.2** | Win7/8.x 兼容包，产物名带 `-win7` 后缀 |
| `build-macos-universal` | stable | 未签名、不公证 |
| `build-linux-x64` | stable | `.deb` / `.AppImage`，用 `--config` 把 productName 覆盖为 ASCII（deb 包名限制） |
| `build-linux-arm64` | 1.77.2（容器内） | arm64 runner + focal 容器，`.deb` / `.AppImage` |

- 两个 Windows job 使用同一份源码与同一份 `Cargo.lock`，只有 Rust 工具链不同。
- 全程无签名步骤；没有 Release job，构建完只把产物挂成 artifact。
- 每个安装包单独一个 artifact，名称就是最终文件名（`座位编排_<版本>_<平台>-<架构>.<扩展名>`）。
  `actions/upload-artifact@v4` 没有 `archive` 输入，`compression-level: 0` 只是「不压缩存储」，下载到的仍是 zip，里面只含那一个文件。
- 缓存 key 按工具链区分（`windows-x64-modern` / `windows-x64-win7`），避免两种工具链共用 target 缓存。

## 7. Win7 部署检查单

1. Windows 7 **SP1** + SHA-2 补丁（KB4474419）+ UCRT（KB2999226）。
2. 安装 **VC++ 2015–2022 x64 运行库**。
3. 安装 **WebView2 运行时 109**（离线包），或按 3.3 方案 B 配置固定运行时目录与环境变量。
4. 再安装 `座位编排_0.1.0_x64-win7-setup.exe`（或对应 MSI）。
5. 首次启动若报缺少运行时，先回查第 3 步是否装的是 **109**，而不是更新的版本。
