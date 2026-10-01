"""本地文件检索

"本地是否已存在这首歌"只依据**目标下载目录**里的实际文件判断，
下载历史（download_tasks）仅用于展示音质等信息，不参与是否存在/是否下载的决策。

对外主要接口：
- find_existing_file(dir, song_display_name) -> dict | None  在指定目录里找同名歌曲
- describe_file(path) -> dict                                文件的音质/大小等描述信息
"""

import os
import re
from typing import Dict, Iterator, Optional

from shared_state import download_tasks

# 视为音频文件的扩展名
AUDIO_EXTENSIONS = {
    ".flac", ".mp3", ".m4a", ".ogg", ".acc", ".aac",
    ".wav", ".ape", ".wma", ".mp4", ".mka",
}

# 文件名里带音质关键字时的显示名（枚举名 → 显示名）
QUALITY_FILENAME_KEYWORDS = {
    "MASTER": "臻品母带",
    "ATMOS": "臻品全景声",
    "FLAC": "SQ无损音质",
    "OGG_640": "极高音质",
    "OGG_320": "HQ高品音质",
    "MP3_320": "HQ较高音质",
    "ACC_192": "较高音质",
    "OGG_192": "标准音质",
    "MP3_128": "标准音质",
    "ACC_96": "流畅音质",
    "OGG_96": "流畅音质",
    "ACC_48": "超低音质",
    # 用户自己按音质档位命名时的简写，放最后避免误命中
    "SQ": "SQ无损音质",
    "HQ": "HQ高品音质",
}

# 文件名里没有音质信息时，按扩展名给出的兜底提示
EXT_QUALITY_HINT = {
    ".flac": "无损 (FLAC)",
    ".mp3": "MP3 格式",
    ".m4a": "ACC/M4A 格式",
    ".ogg": "OGG 格式",
    ".wav": "WAV 格式",
    ".ape": "APE 格式",
}

UNKNOWN_QUALITY = "未知音质"


def human_size(num_bytes) -> str:
    """把字节数格式化成带单位的大小，如 28.6 MB（日志/通知统一用它）"""
    try:
        size = float(num_bytes)
    except (TypeError, ValueError):
        return "未知大小"
    if size < 0:
        return "未知大小"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{int(size)} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def _clean(name: str) -> str:
    """去掉文件名里的非法字符"""
    return re.sub(r'[\\/*?:"<>|]', "", str(name if name is not None else "")).rstrip()


def _norm(name: str) -> str:
    """归一化用于比较：去非法字符、去逗号/空格/&、转小写"""
    return re.sub(r'[,，&\s]', "", _clean(name)).lower()


def _title_of(name: str) -> str:
    """取"歌名 - 歌手"里的歌名部分并归一化"""
    return _norm(str(name).split(" - ")[0])


def same_song_name(name_a: str, name_b: str) -> bool:
    """两个文件名/歌名归一化后是否指向同一首歌

    忽略非法字符、逗号、空格、& 与大小写；用于清理同一首歌的不同格式旧副本。
    """
    return _norm(name_a) == _norm(name_b)


def quality_from_filename(filename: str) -> str:
    """从文件名中提取音质显示名（识别不出返回"未知音质"）"""
    if not filename:
        return UNKNOWN_QUALITY
    stem = os.path.splitext(os.path.basename(filename))[0]
    upper = stem.upper()
    for keyword, quality_name in QUALITY_FILENAME_KEYWORDS.items():
        if keyword in upper:
            return quality_name
    return UNKNOWN_QUALITY


def _quality_from_history(path: str) -> str:
    """从下载历史里查该文件的音质（仅用于展示，不用于判断是否存在）"""
    if not path:
        return ""
    basename = os.path.basename(path)
    norm_path = os.path.normpath(path)
    fallback = ""
    for task in download_tasks.values():
        if not isinstance(task, dict):
            continue
        quality = task.get("quality") or ""
        if not quality:
            continue
        task_path = task.get("file_path") or ""
        if task_path and os.path.normpath(task_path) == norm_path:
            return quality
        if task_path and os.path.basename(task_path) == basename:
            fallback = fallback or quality
    return fallback


def quality_for_file(path: str) -> str:
    """推断本地文件的音质：下载历史 → 文件名关键字 → 扩展名兜底"""
    quality = _quality_from_history(path)
    if quality:
        return quality
    quality = quality_from_filename(path)
    if quality != UNKNOWN_QUALITY:
        return quality
    ext = os.path.splitext(path)[1].lower()
    return EXT_QUALITY_HINT.get(ext, UNKNOWN_QUALITY)


def is_program_downloaded(path: str) -> bool:
    """该文件是否由本程序下载（查下载历史，仅用于展示）"""
    if not path:
        return False
    basename = os.path.basename(path)
    norm_path = os.path.normpath(path)
    for task in download_tasks.values():
        if not isinstance(task, dict):
            continue
        task_path = task.get("file_path") or ""
        if not task_path:
            continue
        if os.path.normpath(task_path) == norm_path or os.path.basename(task_path) == basename:
            return True
    return False


def describe_file(path: str) -> Dict:
    """构造一个本地文件的描述信息（音质 / 大小 / 扩展名等）"""
    basename = os.path.basename(path)
    stem, ext = os.path.splitext(basename)
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return {
        "filename": basename,
        "basename": stem,
        "path": path,
        "size": size,
        "extension": ext.lstrip("."),
        "quality": quality_for_file(path),
        "is_program_downloaded": is_program_downloaded(path),
    }


def iter_audio_files(directory: str, recursive: bool = True) -> Iterator[str]:
    """遍历目录下的音频文件（跳过隐藏文件/目录）"""
    if not directory or not os.path.isdir(directory):
        return
    if recursive:
        for root, dirs, files in os.walk(directory):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for filename in files:
                if filename.startswith("."):
                    continue
                if os.path.splitext(filename)[1].lower() in AUDIO_EXTENSIONS:
                    yield os.path.join(root, filename)
    else:
        for filename in os.listdir(directory):
            if filename.startswith("."):
                continue
            if os.path.splitext(filename)[1].lower() in AUDIO_EXTENSIONS:
                yield os.path.join(directory, filename)


class DirIndex:
    """某个目录下音频文件的索引，支持一次扫描、多次按歌名查找"""

    def __init__(self, directory: str, recursive: bool = True):
        self.directory = directory
        self.by_norm = {}    # 归一化文件名 → 路径
        self.by_title = {}   # 归一化歌名 → 路径
        for path in iter_audio_files(directory, recursive=recursive):
            stem = os.path.splitext(os.path.basename(path))[0]
            norm = _norm(stem)
            if norm and norm not in self.by_norm:
                self.by_norm[norm] = path
            title = _title_of(stem)
            if title and title not in self.by_title:
                self.by_title[title] = path

    def __len__(self) -> int:
        return len(self.by_norm)

    def find(self, song_display_name: str) -> Optional[str]:
        """查找同一首歌的文件路径：先整个文件名精确匹配，再退回歌名匹配"""
        if not song_display_name:
            return None
        target = _norm(song_display_name)
        if target and target in self.by_norm:
            return self.by_norm[target]
        target_title = _title_of(song_display_name)
        if len(target_title) >= 2 and target_title in self.by_title:
            return self.by_title[target_title]
        return None


def find_existing_file(
    directory: str,
    song_display_name: str,
    recursive: bool = True,
) -> Optional[Dict]:
    """在指定目录里查找"同一首歌"的本地文件

    判定顺序：
    1. 归一化后的完整文件名完全相同（最可靠，程序下载的文件都能命中）
    2. 归一化后的歌名部分相同（应对手动改名/没带歌手的情况）

    Args:
        directory: 要检索的目录
        song_display_name: 形如 "歌名 - 歌手1, 歌手2" 的显示名
        recursive: 是否递归子目录（歌单目录需要，日期文件夹在子目录里）

    Returns:
        describe_file() 的结果；没找到返回 None
    """
    if not directory or not song_display_name or not os.path.isdir(directory):
        return None

    path = DirIndex(directory, recursive=recursive).find(song_display_name)
    return describe_file(path) if path else None
