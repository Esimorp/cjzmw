# 超级字幕王（cjzmw）

本地运行的中文视频字幕工作台：**导入视频 → 语音识别 / 导入 TXT → 强制对齐 → 逐字校订 → 导出烧录字幕的 MP4**。

视频、音频与字幕都留在自己的机器上：识别由本地 Qwen3-ASR 运行时完成，预览与导出由本地 Remotion + Chromium 渲染，运行时不访问任何云端服务。整个流程只处理**音频、文本和像素渲染**，不调用视觉/多模态模型，详见[模型使用说明](#模型使用说明不使用视觉模型)。

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [部署说明](#部署说明)
- [使用说明](#使用说明)
- [环境变量](#环境变量)
- [常见问题](#常见问题)
- [HTTP API](#http-api)
- [开发与测试](#开发与测试)
- [项目结构](#项目结构)
- [实现要点](#实现要点)
- [模型使用说明：不使用视觉模型](#模型使用说明不使用视觉模型)

## 功能概览

| 功能 | 说明 |
| --- | --- |
| 视频导入 | 上传本地视频，`ffprobe` 读取时长、分辨率、帧率、编码，浏览器直接预览。单文件上限 **2 GB**，不做转码 |
| 语音识别 | 本地 Qwen3-ASR（CPU，中文），输出段落与**逐字时间戳**；任务排队、可取消，单任务上限 30 分钟 |
| 强制对齐 | 用已有字幕文本 + 同一段音频做强制对齐，得到逐字时间戳 |
| TXT 导入 | UTF-8 文本，**一行 = 一段字幕**，导入后替换当前字幕，再由强制对齐补时间 |
| 逐字校订 | 段落编辑、段落内换行、光标处插入段落、向前/向后合并、点击段落定位、点击词元查看起止时间、词元样式（默认样式 / 重点） |
| 画面预览 | Remotion Player 帧级预览，与导出使用同一份 composition |
| MP4 导出 | 服务端 Remotion 渲染，烧录字幕并保留原音轨，完成后浏览器自动下载；同一时间只跑一个导出 |
| 工作区 | 自动保存与恢复：刷新页面或重启服务后可继续编辑 |

## 技术栈

- **Express 5** — HTTP 服务；开发模式挂载 Vite 中间件
- **React 19** — 服务端 `renderToString`，客户端 `hydrateRoot`
- **Vite 8** — 开发中间件、`transformIndexHtml`、`ssrLoadModule`、客户端与 SSR 构建
- **tsx** — 开发模式下运行并监听 `server.ts`
- **Remotion 4.0.536** — 预览播放器与 MP4 服务端渲染
- **TypeScript 6 / Node 24** — Node 原生执行 `.ts`（`node server.ts`）
- **Oxlint** — 代码检查
- **[Qwen3-ASR-GGUF](https://github.com/HaujetZhao/Qwen3-ASR-GGUF)** — 本地语音识别与强制对齐（Qwen3-ASR + Qwen3-ForcedAligner，ONNX Encoder + GGUF Decoder，CPU 推理）

## 环境要求

### 运行必需

| 项目 | 要求 | 缺失后果 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 或 Windows Server x64（`inference/bin` 放的是 Windows x64 版 llama.cpp 二进制） | 语音识别/强制对齐不可用 |
| Node.js | ≥ 24（本项目在 v24.15 上验证；`pnpm start` 直接执行 `server.ts`） | 无法启动 |
| pnpm | ≥ 9（lockfile v9，本项目在 11.1 上验证） | 无法安装依赖 |
| ffmpeg / ffprobe | 在 `PATH` 中，或用环境变量指定绝对路径 | 上传与识别失败 |
| 磁盘 | `lib/qwen` ≈ 1.5 GB、首次导出 Chromium ≈ 440 MB、上传视频最大 2 GB | — |
| 内存 | CPU 推理建议 ≥ 8 GB，长音频需要更多 | — |

### 仅语音识别 / 强制对齐需要

- Python 3.14（推荐）或 3.12，项目内虚拟环境 `.venv`
- `lib/qwen/`：本地模型与推理源码（来自 [HaujetZhao/Qwen3-ASR-GGUF](https://github.com/HaujetZhao/Qwen3-ASR-GGUF)，约 1.5 GB，不随仓库分发）

缺少这两项时，**上传视频、导入 TXT、编辑字幕、预览与导出仍可正常使用**，只有「语音识别 / 强制对齐」会失败。

### 仅字幕预览 / 导出需要

- `public/SmileySans-Oblique.ttf`
- `public/JetBrainsMono-Bold.ttf`

两个字体文件被 `.gitignore` 忽略，不随仓库分发。缺少任一个都会让 Remotion 的 `loadFont()` 失败并取消渲染，**导出直接失败**。

## 快速开始

```powershell
pnpm install
pnpm dev          # http://localhost:5173
```

开发模式使用 Vite 中间件与 HMR：`tsx watch server.ts` 会在服务端文件变化时重启，客户端走 Vite 热更新。

最小可用（暂不配置语音识别）：

1. 把 `SmileySans-Oblique.ttf`、`JetBrainsMono-Bold.ttf` 放进 `public/`
2. `pnpm install`
3. `pnpm dev`
4. 打开页面，点「选择视频」→「上传字幕」→ 编辑 →「导出」

首次导出会自动下载 Remotion 的 Chromium（本机缓存约 440 MB），需要能访问网络；之后可离线导出。

## 部署说明

### 部署形态与限制

- **单实例、单工作区、单用户**：应用只维护一个 `workspace.json`，同一时间只有一个视频和一串字幕。
- **没有内置鉴权**：能访问端口的人都能上传/删除视频、触发识别与导出。请部署在本机或可信内网，或放在带认证的反向代理之后。
- **推理串行**：同时最多 1 个识别任务运行，最多 4 个排队，单任务 30 分钟超时。
- **导出串行**：同一时间只允许一个导出；导出期间会锁定当前视频（删除会被拒绝）。
- **持久化目录必须使用本地磁盘**，不要把 `storage/` 放在会被清理的临时目录。

### 1. 获取代码并安装依赖

```powershell
git clone <repository-url> cjzmw
cd cjzmw
pnpm install --frozen-lockfile
```

### 2. 安装 ffmpeg / ffprobe

```powershell
winget install --id Gyan.FFmpeg -e
ffmpeg -version
ffprobe -version
```

若没有加入 `PATH`，用环境变量显式指定（服务子进程会继承）：

```powershell
$env:FFMPEG_PATH  = 'C:\ffmpeg\bin\ffmpeg.exe'
$env:FFPROBE_PATH = 'C:\ffmpeg\bin\ffprobe.exe'
```

- `ffprobe` 用于上传时读取视频元数据，缺失时上传返回 `503 FFPROBE_UNAVAILABLE`。
- `ffmpeg` 用于抽取 16 kHz 单声道音频，缺失时识别任务失败并报 `FFMPEG_UNAVAILABLE`。

### 3. 准备 Qwen3-ASR 运行时

语音识别与强制对齐使用 **[HaujetZhao/Qwen3-ASR-GGUF](https://github.com/HaujetZhao/Qwen3-ASR-GGUF)**——Qwen3-ASR 与 Qwen3-ForcedAligner 的 ONNX + GGUF 混合推理实现。本项目直接引用其源码包与模型，不做修改；`lib/qwen/` 被 `.gitignore` 忽略，需要手动放入。

#### lib 放置结构

```text
lib/qwen/
├─ model/                                     # 模型权重（约 1.5 GB）
│  ├─ qwen3_asr_encoder_frontend.int4.onnx
│  ├─ qwen3_asr_encoder_backend.int4.onnx
│  ├─ qwen3_asr_llm.q4_k.gguf
│  ├─ qwen3_aligner_encoder_frontend.int4.onnx
│  ├─ qwen3_aligner_encoder_backend.int4.onnx
│  └─ qwen3_aligner_llm.q4_k.gguf
└─ qwen_asr_gguf/                             # 上游 Python 源码包（必须可被 import）
   ├─ __init__.py
   └─ inference/
      ├─ __init__.py
      ├─ asr.py                               # ASR 引擎
      ├─ asr_worker.py                        # 异步编码进程
      ├─ aligner.py                           # 强制对齐
      ├─ encoder.py / llama.py                # ONNX / llama.cpp 封装
      ├─ exporters.py / chinese_itn.py        # SRT/JSON/TXT 导出、中文数字规整
      ├─ schema.py / utils.py
      ├─ assets/                              # 语言处理资源（如韩语词典）
      └─ bin/                                 # llama.cpp 预编译二进制（Windows x64）
         ├─ llama.dll
         ├─ ggml.dll、ggml-base.dll、ggml-cpu-*.dll
         ├─ ggml-vulkan.dll、ggml-rpc.dll
         ├─ mtmd.dll、libomp140.x86_64.dll
         └─ llama-quantize.exe
```

各部分的来源与放置位置：

| 内容 | 来源 | 放置位置 |
| --- | --- | --- |
| 模型权重（上方 6 个文件） | 上游 [models release](https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/tag/models) 的模型压缩包 | 解压到 `lib/qwen/model/` |
| Python 源码包 `qwen_asr_gguf/` | 上游仓库根目录的同名目录 | `lib/qwen/qwen_asr_gguf/` |
| llama.cpp 预编译二进制 | **上游仓库不提供**，需自行从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 下载 `llama-bXXXX-bin-win-vulkan-x64.zip` | 解压后把 DLL 放到 `lib/qwen/qwen_asr_gguf/inference/bin/` |

放置说明：

- 上游只提供 Python 推理源码（`qwen_asr_gguf/`）与单独发布的模型包（models release），**不附带 llama.cpp 二进制**；`inference/bin/` 需要按上表手动放入。
- 本项目只使用 `model/` 与 `qwen_asr_gguf/`；`transcribe.exe`、`internal/` 是冻结版运行时的产物（不在上游仓库源码中），`export/`、`readme.md` 是转换/说明材料，均不参与运行，可以不复制。
- DLL 必须放在 `qwen_asr_gguf/inference/bin/`：`python/qwen_worker.py` 启动时会把该目录加入 `PATH` 和 Windows DLL 搜索目录（上游文档写作 `qwen_asr_gguf/bin/`，与本项目的目录结构不同）。
- ASR 可选 0.6B 或 1.7B 权重，保持上方列出的默认文件名即可，worker 按 `qwen_asr_gguf/inference/schema.py` 中的默认文件名加载。
- 运行时目录可以用 `QWEN_ASR_DIR` 指向别处，结构保持不变。

#### 创建虚拟环境

在项目内创建虚拟环境（不污染全局 Python）：

```powershell
powershell -ExecutionPolicy Bypass -File python\setup.ps1
```

脚本会使用 `py -3.14` 创建 `.venv`、安装 `python/requirements.txt` 并验证导入。若本机没有合适的 Python，可按 [python/SETUP.md](python/SETUP.md) 用 `uv` 创建项目内的 3.12 解释器。

验证运行时：

```powershell
.\.venv\Scripts\python.exe -c "import sys; sys.path.insert(0,'lib/qwen'); import qwen_asr_gguf.inference as m; print(m.QwenASREngine, m.QwenForcedAligner)"
```

说明：

- worker 直接以源码方式导入 `lib/qwen/qwen_asr_gguf`，不需要把它安装进 venv，也不需要改上游代码。
- worker 以纯 CPU 模式启动：`VK_ICD_FILENAMES=none`、`GGML_VULKAN=0`，无需 GPU 驱动。
- 识别语言固定为中文（`language: 'Chinese'`），界面暂不提供语言切换。
- 可用 `QWEN_ASR_DIR`、`QWEN_PYTHON` 指向别处的运行时/解释器（见[环境变量](#环境变量)）。

### 4. 放置字幕字体

```text
public/SmileySans-Oblique.ttf
public/JetBrainsMono-Bold.ttf
```

字体只影响播放器与烧录字幕；左侧编辑区使用系统字体。

### 5. 构建

```powershell
pnpm build
```

该命令依次执行类型检查（`tsc -b`）、客户端构建与 SSR 构建，产物为：

- `dist/client` — 浏览器静态资源
- `dist/server/entry-server.js` — SSR 渲染入口

### 6. 启动

```powershell
pnpm start          # 等价于 node server.ts --production
```

默认端口 **3000**（开发默认 5173），可通过 `PORT` 修改：

```powershell
$env:PORT = '8080'
pnpm start
```

服务监听所有网卡，访问 `http://<主机>:3000`。生产模式从 `dist/client` 提供页面与资源，从 `public/` 提供视频和字体。

设置 `NODE_ENV=production` 与 `--production` 等价：

```powershell
$env:NODE_ENV = 'production'
pnpm start
```

### 7. 预下载 Chromium（离线/内网部署建议）

导出始终使用 Remotion 自带的 Chromium（`chrome-for-testing`，带 H.264/AAC 解码），首次导出时下载到 `node_modules/.remotion/`：

```powershell
node -e "import('@remotion/renderer').then(({ ensureBrowser }) => ensureBrowser({ chromeMode: 'chrome-for-testing' }))"
```

下载完成后即可离线渲染。注意：重新 `pnpm install` 或删除 `node_modules` 后需要再次下载，建议保留或单独备份 `node_modules/.remotion`。

### 8. 目录与权限

| 路径 | 用途 | 说明 |
| --- | --- | --- |
| `storage/workspace/` | `workspace.json`：视频信息 + 全部字幕 | 持久数据，务必备份 |
| `public/videos/` | 当前视频文件 | 启动时自动创建；替换视频时清理旧文件 |
| `storage/exports/` | 导出临时文件 | 进程退出时清空；导出结果由浏览器下载 |
| `node_modules/.remotion/` | Chromium 与浏览器缓存 | 首次导出创建 |
| `lib/qwen/` | ASR 模型与源码 | 只需读权限 |

运行用户必须对 `storage/`、`public/videos/`、`node_modules/.remotion/` 有写权限。

### 9. 反向代理配置

上传是单次 ≤ 2 GB 的 multipart 请求，识别/导出进度是短轮询（无 WebSocket/SSE），代理主要需要放开上传大小与超时：

```nginx
server {
    listen 80;
    server_name subtitle.example.com;

    client_max_body_size 2100m;
    proxy_request_buffering off;   # 避免 2 GB 上传在代理层再写一份临时文件
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

视频以静态文件形式从 `/videos/<id>.<ext>` 提供，支持 `HEAD` 与 `Range`（`206`/`416`），无需额外代理规则。

### 10. 作为 Windows 服务运行（可选）

使用 [NSSM](https://nssm.cc/)：

```powershell
nssm install cjzmw "C:\Program Files\nodejs\node.exe" "server.ts --production"
nssm set cjzmw AppDirectory C:\path\to\cjzmw
nssm set cjzmw AppEnvironmentExtra NODE_ENV=production PORT=3000
nssm set cjzmw AppStdout C:\path\to\cjzmw\storage\server.log
nssm set cjzmw AppStderr C:\path\to\cjzmw\storage\server.err.log
nssm start cjzmw
```

进程收到 `SIGINT`/`SIGTERM` 时会优雅关闭：关闭 HTTP 服务、取消识别/导出任务、清理临时文件；10 秒内未完成则强制退出。

### 11. 部署自检

1. 访问 `http://<主机>:3000/`，页面正常渲染
2. 「选择视频」后能看到文件名、时长、分辨率、帧率、编码
3. 「语音识别」任务经历 `排队 → 运行 → 完成`，字幕带逐字时间戳
4. 「导出」进度到 100%，浏览器自动下载 MP4

## 使用说明

### 界面结构

顶部工具栏是一套固定流程：**选择视频 → 语音识别 / 上传字幕 → 强制对齐 → 导出**。左侧是字幕分段列表（逐字校订），右侧是画面预览，字幕列表上方的状态提示会显示任务进度与错误。

### 1. 选择视频

点击「选择视频」，选取本地视频（`video/*`）。服务端用 `ffprobe` 读取元数据后把文件复制到 `public/videos/`，页面随即显示预览与元信息。

- 上限 2 GB（超出返回 413）；无法解析的文件返回 422
- **新视频会替换工作区里已有的视频，并把字幕清空**

### 2. 语音识别

选好视频后点「语音识别」。任务在服务端排队执行，界面显示「排队中（前面还有 N 个任务）」「正在识别语音…」等状态，可随时点「取消识别」。

完成后字幕按段落填入左侧列表，每个词带有逐字时间戳：

- **模型时间戳** — 模型直接给出的整段边界
- **推算时间戳** — 由字符插值得到的词/字边界
- **无可靠时间戳** — 文本无法匹配到识别结果

### 3. 上传 TXT 字幕

点「上传字幕」选择 `.txt` 文件（UTF-8）：

- **一行 = 一段字幕**，空行忽略
- 仅支持 `.txt`；编码不是 UTF-8 时会提示另存为 UTF-8
- 导入会**替换**当前所有字幕，导入后这些段落没有时间戳

### 4. 强制对齐

已经有字幕文本（识别结果或 TXT 导入）且已选择视频时，点「强制对齐」，用音频为每个词计算时间戳。限制：

- 最多 400 段、4000 个词元，请求体 ≤ 512 kb
- 编辑字幕之后，列表上方会提示「字幕有变化，需要重新强制对齐」

### 5. 逐字校订

| 操作 | 效果 |
| --- | --- |
| 点击某一段 | 播放器跳到该段开始时间 |
| 「编辑」 | 打开编辑框；段落内按回车可换行，保存后仍是同一段 |
| 编辑框「插入段落」 | 按光标位置把当前段拆成两段，并立即保存 |
| 「向前合并」/「向后合并」 | 与相邻段合并，保留当前段的文字 |
| 点击某个词 | 弹窗显示开始 / 结束 / 持续时间，并可选择样式 |
| 样式 | `默认样式`（常规）与 `重点`（更大更重，朗读时放大并带粉色发光） |

样式只作用于播放器与导出画面，不改变左侧编辑区的排版。所有编辑都会自动保存。

### 6. 画面预览

右侧 Remotion Player 按视频真实分辨率与帧率播放，字幕层级、换行、样式与导出结果完全一致（同一份 composition）。

### 7. 导出 MP4

点「导出」后，服务端用 Remotion 渲染**当前视频 + 当前字幕快照**（渲染开始后再编辑不影响这次导出），完成后浏览器自动下载 MP4。

- 需要已选视频且至少有一段字幕（否则接口返回 `400 NO_SUBTITLES`）
- 界面显示进度条与「取消」；服务端同一时间只跑一个导出
- 渲染在服务端完成，带有原始音轨，不依赖浏览器的 WebCodecs
- 导出耗时约与视频时长成正比；遇到单帧解码头超时可调大 `EXPORT_TIMEOUT_MS`

### 8. 工作区自动保存与恢复

- TXT 导入、编辑、删除、合并、识别/对齐完成都会触发 600 ms 防抖自动保存
- 刷新页面或重启服务后自动恢复视频与字幕；恢复完成前不会开始自动保存，避免覆盖磁盘上的数据
- 多标签页同时编辑时，落后的一方会看到「工作区已在其他标签页被修改，请刷新后再保存」
- 不恢复：进行中的识别/对齐任务、打开的编辑框与草稿
- `workspace.json` 损坏时原文件保持不变，界面提示「工作区数据无法读取」并停止自动保存

### 9. 键盘操作

- `Esc`：关闭编辑框 / 词元弹窗
- 词元上 `Enter` 或空格：打开词元信息

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 开发 `5173`，生产 `3000` | HTTP 端口 |
| `NODE_ENV` | 未设置 | 设为 `production` 时等价于 `--production` |
| `FFPROBE_PATH` | `ffprobe` | `ffprobe` 可执行文件绝对路径 |
| `FFMPEG_PATH` | `ffmpeg` | `ffmpeg` 可执行文件绝对路径 |
| `QWEN_ASR_DIR` | `lib/qwen` | Qwen3-ASR 运行时目录（`model/` + `qwen_asr_gguf/`） |
| `QWEN_PYTHON` | `.venv\Scripts\python.exe` | worker 解释器路径 |
| `WORKSPACE_DIR` | `storage/workspace` | 工作区 JSON 目录 |
| `PUBLIC_DIR` | `public` | 静态根目录；视频存放在 `<PUBLIC_DIR>/videos` |
| `EXPORT_DIR` | `storage/exports` | 导出临时目录 |
| `EXPORT_CONCURRENCY` | `1` | Remotion 渲染并发（每帧并行解码反而更慢，默认 1） |
| `EXPORT_TIMEOUT_MS` | `180000` | 渲染单步超时，最小 `30000` |
| `REMOTION_LOG_LEVEL` | `verbose` | Remotion 日志级别：`trace`/`verbose`/`info`/`warn`/`error` |

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 上传失败，提示 ffprobe 不可用（`503 FFPROBE_UNAVAILABLE`） | `ffprobe` 不在 `PATH`；安装 ffmpeg 或设置 `FFPROBE_PATH` |
| 上传返回 413 | 文件超过 2 GB；先压缩/裁剪再上传 |
| 上传返回 422 | 文件没有视频流或元数据无法解析（例如纯音频、损坏文件） |
| 识别任务失败，`FFMPEG_UNAVAILABLE` | 无法启动 `ffmpeg`；检查 `FFMPEG_PATH`/`PATH` |
| 识别任务失败，`ASR_RUNTIME_UNAVAILABLE` | `.venv` 解释器或 `lib/qwen` 缺失；执行 `python\setup.ps1` 并检查 `QWEN_PYTHON` |
| 识别一直显示排队 | 同一时间只跑一个任务，队列上限 4；等前一个任务结束 |
| 识别很慢 | CPU 推理；长视频耗时显著，可在空闲机器上运行，单任务 30 分钟后会被终止 |
| 导出失败 | 检查 `public/` 下两个字体文件是否齐全、`node_modules/.remotion` 是否可写；查看服务端 `[export ...]` 日志 |
| 导出按钮无反应/报错 | 需要先有视频和至少一段字幕 |
| 播放器没有字幕字体 | 字体文件缺失或未重启服务；确认 `public/` 下两个 TTF 可访问 |
| 保存时提示「工作区已在其他标签页被修改」 | 另一个标签页写入了更新版本；刷新页面后继续 |
| 重启后字幕还在但视频丢失 | `public/videos/` 中的文件被清理；重新上传视频（字幕会重置） |
| `pnpm start` 报未知文件扩展名 | Node 版本过低（需 ≥ 24，原生执行 TypeScript） |

## HTTP API

所有接口挂在 `/api` 下，返回 JSON；未知 `/api` 路径返回 `404 { error, code }`。视频字节本身走静态路径 `/videos/<id>.<ext>`。

### 视频

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/videos` | `multipart/form-data`，字段名 `video`，单个文件 ≤ 2 GB；用 `ffprobe` 探测后落盘，返回 `201` + `VideoMetadata` |
| `DELETE` | `/api/videos/:id` | 删除视频，`204`；被识别/导出任务占用时返回 `409 VIDEO_BUSY` |

```ts
interface VideoMetadata {
  id: string          // UUID
  url: string         // /videos/<id>.<ext>
  publicPath?: string // 相对 public 根目录的路径，如 videos/<id>.mp4（旧文档可能没有）
  filename: string    // 清理后的原始文件名
  size: number        // 字节
  duration: number    // 秒
  width: number       // 显示宽度（已应用旋转）
  height: number      // 显示高度（已应用旋转）
  fps: number         // avg_frame_rate，回退 r_frame_rate
  codec: string       // 视频编码
}
```

### 工作区

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/workspace` | 返回 `{ workspace, writable, corrupt, restoreError, videoFileMissing }` |
| `PUT` | `/api/workspace` | 提交 `{ revision, video, segments }`；版本不匹配返回 `409 WORKSPACE_CONFLICT` |

`workspace` 文档结构：`{ revision, video, segments, updatedAt }`。写入是原子的（临时文件 + rename）且串行化；视频身份不能通过保存被替换。

### 语音识别 / 强制对齐

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/videos/:id/asr` | 排队识别，`202 { id, kind: "asr", status }`；`409 ASR_BUSY` / `409 ASR_QUEUE_FULL` |
| `POST` | `/api/videos/:id/align` | 排队对齐，body 为 `{ segments: [{ id, tokens: [{ id, text }] }] }`（≤ 512 kb），`202` |
| `GET` | `/api/asr/jobs/:id` | 任务状态 `queued`（带 `queuePosition`）/ `running` / `completed` / `failed`，完成时带 `result` |
| `DELETE` | `/api/asr/jobs/:id` | 取消排队/运行中的任务（杀掉进程树）或丢弃已完成任务，始终 `204` |

任务结果 `result` 包含 `kind`、`text`、`srt`、`raw: [{ text, start, end }]`（秒）以及带逐字时间戳的 `segments`。

### 导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/export` | body `{ segments, styles }`，`202` 返回任务（`409 NO_VIDEO` / `409 EXPORT_BUSY` / `400 NO_SUBTITLES`） |
| `GET` | `/api/export/:id` | 状态 `preparing` / `rendering` / `completed` / `failed` / `cancelled`、`progress`(0-1)、`message` |
| `GET` | `/api/export/:id/file` | 下载渲染完成的 MP4（`Content-Disposition: attachment`） |
| `DELETE` | `/api/export/:id` | 取消渲染并删除输出文件 |

## 开发与测试

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | `tsx watch server.ts`，端口 5173，Vite 中间件 + HMR |
| `pnpm build` | `tsc -b` + 客户端构建 + SSR 构建 |
| `pnpm start` / `pnpm preview` | `node server.ts --production`，端口 3000 |
| `pnpm lint` | Oxlint |
| `pnpm test` | `node --test tests/*.test.ts`（Node 24 原生执行 TS） |
| `pnpm typecheck-tests` | 对测试与配置文件做类型检查 |

测试覆盖字幕时间戳映射、断行、样例数据、工作区持久化与 ASR 路由。改动后建议至少执行：

```powershell
pnpm test
pnpm build
```

## 项目结构

```text
index.html                # SSR 模板，含 <!--app-head--> / <!--app-html--> 占位
server.ts                 # Express 5 + node:http（开发中间件 / 生产静态 + SSR）
media-server.ts           # /api 视频上传、探测、删除
workspace-server.ts       # /api 工作区读取、保存、原子写盘
asr-server.ts             # /api 语音识别与强制对齐任务队列
export-server.ts          # /api 导出：Remotion 打包 + MP4 渲染
python/qwen_worker.py     # Qwen3-ASR / 强制对齐 worker
python/setup.ps1          # 项目内虚拟环境一键准备
python/requirements.txt   # worker 依赖（CPU only）
python/SETUP.md           # worker 环境与请求/结果格式
src/App.tsx               # 主界面：工具栏、字幕列表、编辑与任务状态
src/VideoStage.tsx        # Remotion composition（视频 + 烧录字幕），预览与导出共用
src/remotion-root.tsx     # composition 注册与 calculateMetadata
src/player-fonts.ts       # 通过 loadFont 加载 public/ 下的字幕字体
src/subtitle-timing.ts    # 原始 ASR → 逐字时间戳映射（纯函数，前后端共用）
src/subtitle-sample.ts    # 未恢复工作区时的示例字幕
src/subtitles.css         # 播放器字幕样式与词元样式类
tests/                    # node:test 测试
vite.config.ts            # 客户端构建 + SSR 模块热更新插件
vite.config.ssr.ts        # SSR 构建
```

## 实现要点

- **SSR**：`index.html` 中的两个占位符分别注入 head 与 React 标记；开发模式每次请求重新读取模板并经由 `vite.transformIndexHtml`，生产模式使用构建产物。
- **视频即静态文件**：上传后写入 `public/videos/`，浏览器、播放器和导出 bundle 都以同源 `/videos/<id>.<ext>` 访问，天然支持 Range 请求。
- **临时目录**：上传先落在系统临时目录，失败即清理；进程退出时删除临时目录。
- **导出渲染**：`@remotion/bundler` 打包一次并按视频缓存；`@remotion/renderer` 用自带 Chromium 单帧顺序渲染（并发 1），带取消信号与进度。
- **时间戳模型**：识别结果按字符展开；整段匹配的词保留模型边界（`model`），碎片与重组按字符插值（`interpolated`），无法匹配的文本保持 `null`（`unmatched`）而不做外推。

## 模型使用说明：不使用视觉模型

本项目**不使用任何视觉模型，也不做画面理解**：

- 语音识别的输入只有 `ffmpeg` 抽取的 **16 kHz 单声道音频**，不读取视频帧，不做 OCR、场景识别或镜头分析。
- 强制对齐的输入是同一段音频 + 已有字幕文本，同样不涉及画面。
- 预览与导出是确定性的浏览器渲染（Remotion + Chromium），逐帧绘制 HTML/CSS，不做生成式推理。
- worker 以纯 CPU 模式启动（`VK_ICD_FILENAMES=none`、`GGML_VULKAN=0`），不需要 GPU 或视觉模型运行时。
- 运行时不调用云端 API；唯一的外部下载是首次导出时获取 Remotion Chromium，可提前预下载（见[部署说明](#7-预下载-chromium离线内网部署建议)）。

因此字幕结果只取决于音频与文本，不会因画面内容不同而产生差异。识别与对齐能力来自 [HaujetZhao/Qwen3-ASR-GGUF](https://github.com/HaujetZhao/Qwen3-ASR-GGUF)（模型为 Qwen3-ASR / Qwen3-ForcedAligner），其运行目录结构见[部署说明](#lib-放置结构)。
