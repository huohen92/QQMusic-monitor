# QQ音乐下载器

一个功能强大的 QQ 音乐下载与歌单监控工具，提供 Web 界面，为您的音乐管理带来无缝体验。

## ✨ 功能特性

- **多方式登录**
  - QQ 扫码登录、微信扫码登录、手机号验证码登录
  - 登录态持久化，重启无需重新登录

- **歌单管理**
  - 浏览自建歌单与收藏歌单
  - 查看歌单内所有歌曲，智能识别本地已下载歌曲
  - 一键下载单曲或整个歌单

- **搜索下载**
  - 网页端搜索歌曲，直接加入下载队列
  - 实时查看下载进度（进行中 / 已完成 / 失败）

- **歌单监控**
  - 监控指定歌单，有新歌加入时自动下载
  - 多任务并行下载，支持断点续传与自动重试

- **网页播放器**
  - 所有歌曲支持在线试听（MP3 320k，全浏览器兼容）
  - 底部播放条，支持进度拖拽、播放/暂停

- **自动写入歌曲信息**
  - 下载完成后自动写入标题 / 歌手 / 专辑 / 封面 / 年份等标签
  - 支持写入普通歌词、逐字歌词、翻译（可分别开关）
  - 可同时生成 `.lrc` 歌词文件

- **通知系统**
  - 企业微信群机器人通知（纯文本）
  - 支持下载成功 / 下载失败 / 歌单更新等事件推送

- **响应式设计**
  - 适配手机端，随时随地管理下载

## 🚀 Docker 部署（推荐）

### 方式一：docker-compose

创建 `docker-compose.yml`：

```yaml
version: '3'
services:
  app:
    image: huohen92/qqmusic-monitor:v0.80
    container_name: QQMusic-monitor
    ports:
      - "6696:6696"
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - /vol1/1000/docker-test/qqmusic-data:/app/data
      - /vol1/1000/docker-test/qqmusic-downloads:/app/downloads
    restart: unless-stopped
```

启动：

```bash
docker compose up -d
```

### 方式二：docker run

```bash
docker run -d \
  --name QQMusic-monitor \
  --restart unless-stopped \
  -p 6696:6696 \
  -e TZ=Asia/Shanghai \
  -v /vol1/1000/docker-test/qqmusic-data:/app/data \
  -v /vol1/1000/docker-test/qqmusic-downloads:/app/downloads \
  huohen92/qqmusic-monitor:v0.80
```

### 目录说明

| 挂载目录 | 容器路径 | 作用 |
|---|---|---|
| `qqmusic-data` | `/app/data` | 登录凭证、设备指纹、配置、任务历史 |
| `qqmusic-downloads` | `/app/downloads` | 已下载的音乐文件 |

> ⚠️ `data` 目录包含登录凭证与设备指纹，**请勿分享或提交到代码库**。

## 📖 使用说明

1. 启动后访问 `http://<服务器IP>:6696`
2. 使用 QQ 扫码、微信扫码或手机号验证码登录
3. 在「配置」页可设置下载音质、并发数、歌词写入、通知等
4. 点开歌单即可查看歌曲并下载；点击「监控」按钮可自动跟踪歌单更新

## ⚠️ 注意事项

- **API 限制**：QQ 音乐对单个账号的下载量有限制（约 190 首/天）。触发后任务会自动进入冷却重试。
- **登录设备限制**：QQ 音乐限制账号的登录设备数量。`data` 目录中的 `device.json` 记录了设备指纹，请保持挂载持久化，否则每次重启都会生成新设备，可能触发「登录设备超限」。
- **异地登录风控**：若在异地 IP 部署登录，可能触发腾讯风控（如「获取 code 失败」）。建议在目标服务器上首次登录，或使用手机号验证码登录。

## 🔨 本地开发

```bash
# 安装依赖
pip install -r requirements.txt

# 启动
python -m uvicorn main:app --host 0.0.0.0 --port 6696
```

## 📄 License

本项目仅供个人学习与备份使用，请遵守 QQ 音乐用户协议及相关法律法规。

## 🙏 致谢与项目来源

本项目是在多个开源项目的基础上，结合 AI 辅助开发完成的功能整合版：

- **[Inrrs/QQMusic-monitor](https://github.com/Inrrs/QQMusic-monitor)** — 基础 Web 框架：登录、歌单浏览、下载队列、歌单监控、通知系统的原始实现
- **[L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi)**（`qqmusic-api-python` 0.7.0）— QQ 音乐 API 核心库，本项目的登录、搜索、歌词、播放、用户信息等全部基于其 Client / modules 架构
- **[xhongc/music-tag-web](https://github.com/xhongc/music-tag-web)** — 参考其标签写入思路，使用 [mutagen](https://mutagen.readthedocs.io/) 实现下载后自动写入标题、歌手、专辑、封面、歌词
- **Claude (Anthropic AI)** — 负责代码迁移、功能扩展（企业微信通知、网页播放器、手机端适配、歌词写入、问题修复等）与文档整理

在此基础上新增/增强的功能：企业微信纯文本通知、网页搜索下载、在线播放器、自动写入歌曲信息与歌词、手机端 UI 适配、性能优化等。
