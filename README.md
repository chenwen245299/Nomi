# Nomi

Nomi 是一个面向 macOS 和 Windows 的跨平台桌面应用。当前技术栈为：

- React 19 + TypeScript + Vite
- React Native 0.87 组件 API
- React Native Web 0.21（在桌面 WebView 中渲染 React Native 组件）
- Tauri 2 + Rust（桌面窗口、系统能力与安装包）
- pnpm 11 + Node.js 24 LTS

> 这里的组合不是 `react-native-macos` / `react-native-windows` 原生渲染器。共享 UI 使用
> React Native API 编写，由 React Native Web 渲染到 Tauri 的 WKWebView（macOS）或 WebView2
> （Windows）中。需要操作系统能力时，通过 Tauri 命令或插件调用 Rust。

## 快速开始

```bash
pnpm install
pnpm env:check
pnpm tauri dev
```

常用命令：

```bash
pnpm dev                       # 只启动 Vite 前端
pnpm tauri dev                 # 启动完整 Tauri 桌面应用
pnpm check                     # ESLint、Prettier、TS/Vite 构建、Rust Clippy
pnpm tauri build --no-bundle   # 构建当前系统的 release 可执行文件
pnpm tauri build               # 构建当前系统的安装包
```

## macOS 环境

本机环境已经配置为：

- Node.js 24.19 LTS（由 pnpm 管理，新终端自动加入 PATH）
- pnpm 11.19
- Rust stable、Cargo、rustfmt、Clippy
- Xcode / Apple Clang

首次打开项目后执行 `pnpm tauri dev` 即可。正式分发前还需要配置 Apple Developer
签名与公证；本地开发和未签名构建不受影响。

## Windows 环境

Windows 开发机需要安装以下组件：

1. Node.js 24 LTS 和 pnpm 11。
2. Rustup，并使用默认的 stable MSVC 工具链。
3. Visual Studio 2022 Build Tools，勾选 **Desktop development with C++**。
4. Microsoft Edge WebView2 Runtime（Windows 10 1803 及以上通常已预装）。
5. 如需生成 MSI，确认 Windows 可选功能中的 VBSCRIPT 已启用。

然后在 PowerShell 中运行：

```powershell
pnpm install --frozen-lockfile
pnpm env:check
pnpm tauri dev
```

Windows 安装包必须在 Windows 上构建；macOS 安装包也应在 macOS 上构建。仓库中的 GitHub
Actions 会在两个系统上分别验证前端、Rust 和 Tauri 应用构建。

## 数据目录

Nomi 第一次启动时会要求选择一个本地文件夹，并在其中创建以下结构：

```text
你选择的文件夹/
├── .nomi/
│   └── config.json
├── chat/
├── notes/
├── todo/
├── travel/
└── finance/
```

在“设置 → 数据与存储”中可以随时切换文件夹。空文件夹会自动初始化；如果目标文件夹已有
`.nomi/config.json` 或功能数据，Nomi 会保留并直接读取。应用系统配置目录中只保存一个
`storage-location.json` 位置指针，用来在重启后找回用户选择的数据文件夹，业务数据不会写入那里。

## 项目结构

```text
src/                    React Native / TypeScript UI
src-tauri/              Tauri 配置与 Rust 后端
src-tauri/capabilities/ Tauri 权限能力声明
.github/workflows/      macOS / Windows 持续集成
```

新增共享界面时优先从 `react-native` 导入 `View`、`Text`、`Pressable`、`StyleSheet` 等。
Vite 已把 `react-native` 映射到 `react-native-web`，并支持 `.web.tsx` 平台文件。
