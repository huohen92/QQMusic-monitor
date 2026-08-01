"""音频标签写入模块.

下载完成后自动将歌曲信息（标题/歌手/专辑/曲目号/封面等）写入音频文件。
基于 mutagen，支持 mp3/flac/m4a/ogg 等格式。
"""

import asyncio
import os

import httpx
import mutagen
from mutagen import flac, id3, mp4, oggvorbis

# 封面图片类型
APIC_COVER_FRONT = 3  # Front cover

# ID3v2 标签名（v2.4 帧）
ID3 = id3


def _pick_tag_class(file_path: str):
    """根据文件扩展名返回对应的 mutagen 标签类"""
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".mp3":
        return id3.ID3
    if ext == ".flac":
        return flac.FLAC
    if ext in (".m4a", ".m4b", ".mp4"):
        return mp4.MP4
    if ext in (".ogg", ".opus"):
        return oggvorbis.OggVorbis
    return None


def _download_cover(url: str) -> bytes | None:
    """同步下载封面图片（在 worker 线程中调用）"""
    if not url:
        return None
    try:
        response = httpx.get(url, timeout=15.0, follow_redirects=True)
        response.raise_for_status()
        data = response.content
        if len(data) > 5 * 1024 * 1024:  # 限制封面大小，避免写超大文件
            print(f"封面图片过大，跳过: {len(data)} bytes")
            return None
        return data
    except Exception as e:
        print(f"下载封面失败: {e}")
        return None


def _get_artist(song_info: dict) -> str:
    """从 song_info 提取歌手字符串（兼容字符串列表或对象列表）"""
    singers = song_info.get("singer", [])
    names = [s.name if hasattr(s, "name") else str(s) for s in singers]
    return ", ".join(names)


def _get_lyrics(song_info: dict) -> str:
    """按类型合并歌词：优先逐字(qrc)，其次普通(lyric)，翻译附加到末尾"""
    parts = []
    qrc = song_info.get("lyrics_qrc", "")
    lyric = song_info.get("lyrics", "")
    trans = song_info.get("lyrics_trans", "")
    if qrc:
        parts.append(qrc)
    elif lyric:
        parts.append(lyric)
    if trans:
        parts.append(trans)
    return "\n\n".join(p for p in parts if p)


def _write_id3(audio, song_info: dict, cover: bytes | None) -> None:
    """写入 ID3 标签 (mp3)"""
    audio.add(id3.TIT2(encoding=3, text=[song_info.get("name", "")]))
    artist = _get_artist(song_info)
    if artist:
        audio.add(id3.TPE1(encoding=3, text=[artist]))
    if song_info.get("album"):
        audio.add(id3.TALB(encoding=3, text=[song_info["album"]]))
    if song_info.get("track"):
        audio.add(id3.TRCK(encoding=3, text=[str(song_info["track"])]))
    if song_info.get("year"):
        audio.add(id3.TDRC(encoding=3, text=[str(song_info["year"])]))
    if cover:
        audio.add(
            id3.APIC(
                encoding=3,
                mime="image/jpeg",
                type=APIC_COVER_FRONT,
                desc="Cover",
                data=cover,
            )
        )
    # 歌词：普通/逐字合并进主歌词 USLT，翻译单独一条
    lyric = _get_lyrics(song_info)
    if lyric:
        audio.add(id3.USLT(encoding=3, lang="zho", desc="", text=lyric))
    trans = song_info.get("lyrics_trans", "")
    if trans:
        audio.add(id3.USLT(encoding=3, lang="zho", desc="trans", text=trans))


def _write_flac(audio, song_info: dict, cover: bytes | None) -> None:
    """写入 FLAC 标签 (VorbisComment)"""
    audio["title"] = song_info.get("name", "")
    artist = _get_artist(song_info)
    if artist:
        audio["artist"] = artist
    if song_info.get("album"):
        audio["album"] = song_info["album"]
    if song_info.get("track"):
        audio["tracknumber"] = str(song_info["track"])
    if song_info.get("year"):
        audio["date"] = str(song_info["year"])
    lyric = _get_lyrics(song_info)
    if lyric:
        audio["lyrics"] = lyric
    trans = song_info.get("lyrics_trans", "")
    if trans:
        audio["lyrics-trans"] = trans
    if cover:
        from mutagen.flac import Picture

        picture = Picture()
        picture.type = APIC_COVER_FRONT
        picture.mime = "image/jpeg"
        picture.desc = "Cover"
        picture.data = cover
        audio.add_picture(picture)


def _write_m4a(audio, song_info: dict, cover: bytes | None) -> None:
    """写入 MP4 标签 (m4a)"""
    audio["\xa9nam"] = song_info.get("name", "")
    artist = _get_artist(song_info)
    if artist:
        audio["\xa9ART"] = artist
    if song_info.get("album"):
        audio["\xa9alb"] = song_info["album"]
    if song_info.get("track"):
        audio["trkn"] = [(int(song_info["track"]), 0)]
    if song_info.get("year"):
        audio["\xa9day"] = str(song_info["year"])
    if cover:
        audio["covr"] = [mp4.MP4Cover(cover, imageformat=mp4.MP4Cover.FORMAT_JPEG)]
    lyric = _get_lyrics(song_info)
    if lyric:
        audio["\xa9lyr"] = lyric


def _write_ogg(audio, song_info: dict, cover: bytes | None) -> None:
    """写入 Ogg Vorbis 标签"""
    audio["title"] = song_info.get("name", "")
    artist = _get_artist(song_info)
    if artist:
        audio["artist"] = artist
    if song_info.get("album"):
        audio["album"] = song_info["album"]
    if song_info.get("track"):
        audio["tracknumber"] = str(song_info["track"])
    if song_info.get("year"):
        audio["date"] = str(song_info["year"])
    lyric = _get_lyrics(song_info)
    if lyric:
        audio["lyrics"] = lyric
    trans = song_info.get("lyrics_trans", "")
    if trans:
        audio["lyrics-trans"] = trans
    if cover:
        import base64

        from mutagen.flac import Picture

        picture = Picture()
        picture.type = APIC_COVER_FRONT
        picture.mime = "image/jpeg"
        picture.desc = "Cover"
        picture.data = cover
        audio["metadata_block_picture"] = [base64.b64encode(picture.write()).decode("ascii")]


def write_tags(file_path: str, song_info: dict) -> bool:
    """写入歌曲标签

    Args:
        file_path: 音频文件路径
        song_info: 歌曲信息 dict，含 name/singer/album/track/year/cover_url

    Returns:
        bool: 是否写入成功
    """
    if not os.path.exists(file_path):
        print(f"标签写入失败: 文件不存在 {file_path}")
        return False

    tag_class = _pick_tag_class(file_path)
    if tag_class is None:
        print(f"标签写入失败: 不支持的格式 {file_path}")
        return False

    try:
        # 下载封面（若有）
        cover = None
        cover_url = song_info.get("cover_url")
        if cover_url:
            cover = _download_cover(cover_url)

        # 打开/创建标签并写入
        if tag_class is id3.ID3:
            try:
                audio = tag_class(file_path)
            except id3.ID3NoHeaderError:
                audio = tag_class()  # 创建新标签
            _write_id3(audio, song_info, cover)
            audio.save(file_path)
        elif tag_class is flac.FLAC:
            audio = tag_class(file_path)
            _write_flac(audio, song_info, cover)
            audio.save()
        elif tag_class is mp4.MP4:
            audio = tag_class(file_path)
            _write_m4a(audio, song_info, cover)
            audio.save()
        elif tag_class is oggvorbis.OggVorbis:
            audio = tag_class(file_path)
            _write_ogg(audio, song_info, cover)
            audio.save()

        print(f"标签写入成功: {os.path.basename(file_path)}")
        return True
    except Exception as e:
        print(f"标签写入失败: {e}")
        return False


async def write_tags_async(file_path: str, song_info: dict) -> bool:
    """异步写入歌曲标签（在 worker 线程中执行，避免阻塞事件循环）"""
    return await asyncio.to_thread(write_tags, file_path, song_info)


def write_lrc_file(audio_path: str, song_info: dict) -> bool:
    """生成同名 .lrc 歌词文件（与音频文件同目录、同名）

    合并普通/逐字歌词与翻译为标准 LRC 文本。

    Returns:
        bool: 是否生成成功
    """
    content = _get_lyrics(song_info)
    if not content:
        return False
    try:
        lrc_path = os.path.splitext(audio_path)[0] + ".lrc"
        with open(lrc_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"歌词文件生成成功: {os.path.basename(lrc_path)}")
        return True
    except Exception as e:
        print(f"生成歌词文件失败: {e}")
        return False


async def write_lrc_async(audio_path: str, song_info: dict) -> bool:
    """异步生成 .lrc 歌词文件"""
    return await asyncio.to_thread(write_lrc_file, audio_path, song_info)
