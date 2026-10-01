"""下载目录解析

集中处理"歌曲最终存到哪个目录"的规则，避免各调用方各写一套：

- 单曲下载：使用配置里的 download.default_dir
- 歌单下载：优先用歌单自己配置的 download_dir；留空则用
  <download.downloads_root>/<歌单名称>（容器内即 /app/downloads/<歌单名称>）
- 若该歌单开启了"按日期建文件夹"，歌单下载再追加一层日期目录（YYMMDD，如 261001）

注意：目录名会做非法字符清理，歌单名里的 / \\ : * ? " < > | 等会被去掉。
"按日期建文件夹"是**每个歌单各自**的开关，存在 monitored_playlists.json 里，
随下载任务一起传给 tasks，所以下载时不需要再查全局配置。
"""

import os
import re
import time

from config import config


def sanitize_component(name: str) -> str:
    """清理目录/文件名中的非法字符"""
    cleaned = re.sub(r'[\\/*?:"<>|]', "", str(name if name is not None else ""))
    cleaned = cleaned.strip().rstrip(". ")
    return cleaned or "未命名歌单"


def downloads_root() -> str:
    """下载根目录：歌单默认目录的父目录"""
    root = config.get("download.downloads_root", "")
    if not root:
        # 兜底：用默认下载目录的父目录
        default_dir = config.get("download.default_dir", "")
        root = os.path.dirname(default_dir) if default_dir else "downloads"
    return root


def default_song_dir() -> str:
    """单曲下载的默认目录"""
    return config.get("download.default_dir", "") or "downloads/save"


def default_playlist_dir(title: str = "", playlist_id=None) -> str:
    """歌单下载位置留空时的默认目录：<下载根目录>/<歌单名称>"""
    if title:
        name = sanitize_component(title)
    else:
        name = f"歌单 {playlist_id}" if playlist_id is not None else "未命名歌单"
    return os.path.join(downloads_root(), name)


def date_folder_name(ts=None) -> str:
    """日期目录名，形如 261001（26年10月1日）"""
    return time.strftime("%y%m%d", time.localtime(ts))


def playlist_date_folder_enabled() -> bool:
    """全局兜底开关（正常流程都由每个歌单自己的 date_folder 决定）"""
    return bool(config.get("download.playlist_date_folder", False))


def resolve_target_dir(
    base_dir: str = "",
    playlist_mode: bool = False,
    date_folder=None,
    ts=None,
) -> str:
    """歌曲最终落盘目录

    Args:
        base_dir: 任务上记录的下载目录（空 = 单曲默认目录）
        playlist_mode: 是否来自歌单下载（只有歌单模式才会追加日期目录）
        date_folder: 该歌单自己的"按日期建文件夹"开关；
                     None 表示调用方未指定，退回全局兜底配置
        ts: 时间戳，便于测试
    """
    base_dir = base_dir or default_song_dir()
    if not playlist_mode:
        return base_dir

    enabled = playlist_date_folder_enabled() if date_folder is None else bool(date_folder)
    if enabled:
        return os.path.join(base_dir, date_folder_name(ts))
    return base_dir


def resolve_scan_dir(base_dir: str = "", target_dir: str = "", playlist_mode: bool = False) -> str:
    """判断"本地是否已存在"时要检索的目录

    歌单模式检索整个歌单目录（含各日期子目录），这样开启日期文件夹后，
    昨天下的歌今天也不会被当成不存在而重复下载；单曲模式只查目标目录。
    """
    if playlist_mode and base_dir:
        return base_dir
    return target_dir or base_dir or default_song_dir()
