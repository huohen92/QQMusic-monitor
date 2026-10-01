import asyncio
import os

import aiofiles
import httpx
import orjson as json

import qq_music
from shared_state import download_tasks
from download_paths import resolve_target_dir, resolve_scan_dir
from local_files import find_existing_file, human_size

# --- 配置 ---
DATA_DIR = "data"
TASKS_FILE = os.path.join(DATA_DIR, "download_tasks.json")
# 静态挂载的下载根目录（app.mount("/downloads", ...) 对应的本地路径）
DOWNLOADS_DIR = "downloads"

# 从配置管理模块获取配置
from config import config
# 确保配置值是整数类型
MAX_CONCURRENT_DOWNLOADS = int(config.get("download.max_concurrent", 5))
RETRY_INTERVAL_SECONDS = int(config.get("download.retry_interval_seconds", 24 * 3600))  # 默认24小时

# 确保数据目录在启动时存在
os.makedirs(DATA_DIR, exist_ok=True)

# --- 生产者-消费者 队列 ---
# 这是所有待处理下载任务的中央缓冲池
song_queue = asyncio.Queue()

# --- 任务管理 ---

async def load_download_tasks():
    """从文件加载下载任务，并将中断的任务标记为失败"""
    if not os.path.exists(TASKS_FILE):
        download_tasks.clear()
        return
    try:
        async with aiofiles.open(TASKS_FILE, "rb") as f:
            content = await f.read()
            if not content.strip():
                download_tasks.clear()
                return
            persisted_tasks = json.loads(content)

        for mid, task in persisted_tasks.items():
            if task.get("status") in ["downloading", "queued"]:
                persisted_tasks[mid]["status"] = "failed"
                persisted_tasks[mid]["error"] = "程序重启导致中断"

        download_tasks.clear()
        download_tasks.update(persisted_tasks)
        print(f"已从文件加载 {len(download_tasks)} 条任务历史。")
    except (json.JSONDecodeError, IOError) as e:
        print(f"加载下载任务失败: {e}")
        download_tasks.clear()

async def _save_download_tasks():
    """将当前下载任务列表保存到文件"""
    try:
        # 使用 orjson 进行高效的 JSON 序列化
        json_data = json.dumps(download_tasks, option=json.OPT_INDENT_2)
        async with aiofiles.open(TASKS_FILE, "wb") as f:
            await f.write(json_data)
    except IOError as e:
        print(f"错误：无法保存下载任务文件: {e}")

def _file_url(file_path: str) -> str:
    """把本地文件路径转成 /downloads/... 静态访问地址（不在挂载目录内则返回空）"""
    if not file_path:
        return ""
    try:
        rel = os.path.relpath(file_path, DOWNLOADS_DIR)
    except ValueError:
        return ""
    if rel.startswith(".."):
        return ""
    return "/downloads/" + rel.replace(os.sep, "/")


def _cleanup_old_files(
    target_dir: str,
    scan_dir: str,
    playlist_mode: bool,
    safe_song_name: str,
    keep_path: str,
) -> list:
    """重新下载前，清理同一首歌的旧文件

    - 同一首歌可能已经以别的格式存在（例如上次下了 .ogg，这次拿到 .mp3），
      只按"扩展名相同"清理会漏掉，结果留下两份；
    - 歌单模式会连同各日期子目录一起扫（旧副本可能在别的日期目录里）；
    - 只按"歌名完全一致"匹配，不会误删标题相近的其它歌。

    Returns:
        list: 实际删除的文件路径
    """
    from local_files import iter_audio_files, same_song_name

    removed = []
    keep_norm = os.path.normpath(keep_path)
    root = scan_dir if playlist_mode else target_dir
    for old_full in list(iter_audio_files(root, recursive=playlist_mode)):
        if os.path.normpath(old_full) == keep_norm:
            continue
        old_base = os.path.splitext(os.path.basename(old_full))[0]
        if not same_song_name(old_base, safe_song_name):
            continue
        try:
            os.remove(old_full)
            removed.append(old_full)
            print(f"已删除旧文件（同一首歌、不同格式）: {old_full}")
        except OSError as e:
            print(f"删除旧文件失败: {e}")
    return removed


async def _execute_download(
    song_mid: str,
    song_name: str,
    download_dir: str = "",
    playlist_mode: bool = False,
):
    """实际执行下载的核心逻辑

    Args:
        song_mid: 歌曲 mid
        song_name: 歌曲名称（形如 "歌名 - 歌手"）
        download_dir: 任务记录的下载目录（空则使用默认目录）
        playlist_mode: 是否来自歌单下载（决定是否套用日期文件夹）
    """
    import time

    print(f"开始处理: {song_name}")

    task_state = download_tasks.get(song_mid, {})
    force = bool(task_state.get("force"))

    # 最终落盘目录（歌单模式 + 该歌单开启日期文件夹时，会追加 YYMMDD 子目录）
    target_dir = resolve_target_dir(
        download_dir,
        playlist_mode,
        date_folder=task_state.get("date_folder"),
    )
    # 判断"本地是否已存在"时检索的目录：歌单模式查整个歌单目录（含历史日期子目录）
    scan_dir = resolve_scan_dir(download_dir, target_dir, playlist_mode)

    # 1) 下载前先检索目标目录里有没有同一首歌：有就跳过。
    #    这一步不需要登录，也不请求下载链接（省账号下载额度）
    if not force:
        existing = find_existing_file(scan_dir, song_name)
        if existing:
            file_path = existing["path"]
            print(
                f"本地已存在，跳过下载: {file_path} "
                f"(音质: {existing['quality']}, 大小: {human_size(existing['size'])})"
            )
            download_tasks[song_mid].update({
                "status": "local_exists",
                "progress": 100,
                "quality": existing["quality"],
                "file_size": existing["size"],
                "file_path": file_path,
                "url": _file_url(file_path),
                "error": "本地已存在，已跳过下载",
            })
            await _save_download_tasks()
            return

    # 2) 确实需要下载，再检查登录态
    cred = qq_music.get_credential()
    if not cred:
        print("错误：无法执行下载，因为用户凭证未加载。")
        download_tasks[song_mid].update({"status": "failed", "error": "用户未登录"})
        await _save_download_tasks()
        from notification import notification_manager
        await notification_manager.send_download_failed_notification(song_name, "用户未登录")
        return

    # 从凭证中获取特定于该用户的冷却时间
    cooldown_until = qq_music.get_cooldown_until(cred)
    os.makedirs(target_dir, exist_ok=True)

    # 关键改动：总是先尝试获取下载链接
    url_info = await qq_music.get_song_download_url(song_mid)

    if url_info and url_info.get("url"):
        # 如果成功获取链接，说明限制已解除
        if cooldown_until > 0:
            print("下载链接获取成功，重置该账号的API冷却计时器。")
            qq_music.set_cooldown_until(cred, 0)
        
        url = url_info["url"]
        quality = url_info["quality"]
        file_extension = url_info["extension"]
        import re
        safe_song_name = re.sub(r'[\\/*?:"<>|]', "", song_name).rstrip()
        file_path = os.path.join(target_dir, f"{safe_song_name}{file_extension}")

        # 仅在用户明确"重新下载"（force）时覆盖旧文件；
        # 普通下载在前面已经因为"本地已存在"跳过了，不会走到这里
        if force:
            try:
                if os.path.exists(file_path):
                    os.remove(file_path)
                    print(f"已删除旧文件，准备覆盖: {file_path}")
                # 同一首歌的其它格式副本（例如之前是 .ogg、这次是 .mp3）也一并清掉，
                # 否则会同时留下两份；歌单模式会连各日期子目录一起扫
                _cleanup_old_files(target_dir, scan_dir, playlist_mode, safe_song_name, file_path)
            except Exception as e:
                print(f"清理旧文件失败: {e}")

        download_tasks[song_mid].update({"status": "downloading", "quality": quality})
        await _save_download_tasks()

        try:
            async with httpx.AsyncClient() as client:
                async with client.stream("GET", url, timeout=300.0) as response:
                    response.raise_for_status()
                    total_size = int(response.headers.get("Content-Length", 0))
                    downloaded_size = 0

                    async with aiofiles.open(file_path, "wb") as f:
                        async for chunk in response.aiter_bytes():
                            # 支持取消：下载过程中检测到取消则中断
                            if download_tasks.get(song_mid, {}).get("status") == "cancelled":
                                print(f"任务 {song_name} 已取消，中断下载。")
                                raise asyncio.CancelledError("用户取消下载")
                            await f.write(chunk)
                            downloaded_size += len(chunk)
                            if total_size > 0:
                                progress = int((downloaded_size / total_size) * 100)
                                if download_tasks[song_mid].get("progress") != progress:
                                    download_tasks[song_mid]["progress"] = progress

            file_size = 0
            try:
                if os.path.exists(file_path):
                    file_size = os.path.getsize(file_path)
            except OSError:
                pass
            download_tasks[song_mid].update(
                {
                "status": "completed",
                "progress": 100,
                "file_path": file_path,
                "file_size": file_size,
                "force": False,
                "url": _file_url(file_path)
            })
            print(f"下载完成: {song_name}")

            # 写入歌曲标签 + 歌词（按配置）
            if config.get("download.write_tags", True) or config.get("download.write_lyrics", True):
                try:
                    song_info = await qq_music.get_song_by_mid(song_mid)
                    if song_info:
                        if not config.get("download.write_cover", True):
                            song_info["cover_url"] = ""  # 不写封面

                        # 获取歌词并按配置选择类型
                        if config.get("download.write_lyrics", True):
                            lyrics_data = await qq_music.get_song_lyrics(song_mid)
                            if lyrics_data:
                                if config.get("download.lyric_include_normal", True):
                                    song_info["lyrics"] = lyrics_data.get("lyric", "")
                                if config.get("download.lyric_include_qrc", False):
                                    song_info["lyrics_qrc"] = lyrics_data.get("qrc", "")
                                if config.get("download.lyric_include_trans", True):
                                    song_info["lyrics_trans"] = lyrics_data.get("trans", "")

                        # 写入音频标签（含歌词，按 lyric_write_tag 决定是否带歌词）
                        if config.get("download.write_tags", True):
                            if not config.get("download.lyric_write_tag", True):
                                song_info.pop("lyrics", None)
                                song_info.pop("lyrics_qrc", None)
                                song_info.pop("lyrics_trans", None)
                            from tagging import write_tags_async
                            await write_tags_async(file_path, song_info)

                        # 生成 .lrc 歌词文件（独立开关）
                        if config.get("download.lyric_write_lrc", True):
                            from tagging import write_lrc_async
                            await write_lrc_async(file_path, song_info)
                    else:
                        print(f"未能获取歌曲元数据，跳过标签/歌词写入: {song_mid}")
                except Exception as e:
                    print(f"写入歌曲标签/歌词失败: {e}")

            # 发送下载完成通知（含文件大小和保存位置）
            file_size_str = ""
            try:
                if os.path.exists(file_path):
                    file_size_str = f"{os.path.getsize(file_path) / 1024 / 1024:.1f} MB"
            except OSError:
                pass
            # 保存位置只显示目录（不含文件名），相对路径转为 /app/ 前缀
            display_dir = os.path.dirname(file_path) if file_path else ""
            if display_dir and not display_dir.startswith("/"):
                display_dir = f"/app/{display_dir}"
            from notification import notification_manager
            await notification_manager.send_download_complete_notification(song_name, quality, file_size_str, display_dir)
        except httpx.HTTPStatusError as e:
            error_message = f"HTTP 错误: {e.response.status_code} {e.response.reason_phrase}"
            download_tasks[song_mid].update({"status": "failed", "error": error_message})
            print(f"下载失败: {song_name}, 原因: {error_message}")
            from notification import notification_manager
            await notification_manager.send_download_failed_notification(song_name, error_message)
        except asyncio.CancelledError:
            # 用户取消下载：清理半成品文件，状态已在 cancel 接口置为 cancelled
            try:
                if os.path.exists(file_path):
                    os.remove(file_path)
                    print(f"已删除取消下载的半成品文件: {file_path}")
            except OSError as e:
                print(f"删除半成品文件失败: {e}")
        except Exception as e:
            error_message = f"下载时发生未知错误: {e}"
            download_tasks[song_mid].update({"status": "failed", "error": error_message})
            print(f"下载失败: {song_name}, 原因: {e}")
            from notification import notification_manager
            await notification_manager.send_download_failed_notification(song_name, error_message)

    else:
        # 如果获取链接失败，先检查是否是登录态失效
        from utils import check_login_status
        is_valid, login_msg = await check_login_status(cred)
        if not is_valid:
            print(f"登录状态已失效: {login_msg}")
            from notification import notification_manager
            await notification_manager.send_login_expired_notification(login_msg)

        # 否则假设是API限制
        error_msg = "无法获取下载链接 (可能是API限制)"

        current_time = int(time.time())
        if current_time >= cooldown_until:
            cooldown_duration = RETRY_INTERVAL_SECONDS
            new_cooldown_until = current_time + cooldown_duration
            qq_music.set_cooldown_until(cred, new_cooldown_until)
            print(f"触发API限制，该账号冷却至: {time.ctime(new_cooldown_until)}")
        else:
            new_cooldown_until = cooldown_until
            print(f"该账号仍处于冷却期，使用现有冷却时间: {time.ctime(new_cooldown_until)}")

        download_tasks[song_mid].update({
            "status": "waiting_for_retry",
            "error": "账号超出下载限制",
            "retry_at": new_cooldown_until
        })
        
    await _save_download_tasks()

async def download_worker():
    """消费者：从队列中获取并处理下载任务"""
    while True:
        try:
            song_mid, song_name = await song_queue.get()

            task_state = download_tasks.get(song_mid)
            if not task_state or task_state.get("status") == "cancelled":
                print(f"任务 {song_name} 已被取消，跳过下载。")
                song_queue.task_done()
                continue

            # 从任务状态读取该歌曲的下载目录与下载模式
            task_dir = task_state.get("download_dir", "") if task_state else ""
            task_playlist_mode = bool(task_state.get("playlist_mode")) if task_state else False
            await _execute_download(song_mid, song_name, task_dir, task_playlist_mode)
            song_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"下载工作者出错: {e}")

def start_download_workers():
    """启动指定数量的后台下载工作者并返回它们的任务对象"""
    tasks = []
    for i in range(MAX_CONCURRENT_DOWNLOADS):
        task = asyncio.create_task(download_worker())
        tasks.append(task)
    print(f"已启动 {MAX_CONCURRENT_DOWNLOADS} 个下载工作者。")
    return tasks

async def retry_failed_tasks_periodically():
    """后台任务：定期检查并重试等待中的任务"""
    while True:
        # 缩短检查周期，以便更及时地处理到期的重试任务
        await asyncio.sleep(60) 
        import time
        current_time = int(time.time())

        tasks_to_retry = {
            mid: task
            for mid, task in download_tasks.items()
            if task.get("status") == "waiting_for_retry" and current_time >= task.get("retry_at", float('inf'))
        }

        if not tasks_to_retry:
            continue

        print(f"发现 {len(tasks_to_retry)} 个到期的重试任务，正在将它们重新加入队列...")
        for mid, task in tasks_to_retry.items():
            song_name = task.get("song_name", "未知歌曲")
            await add_song_to_queue(mid, song_name)
        
        # 当任务到期时，我们不需要在这里做任何特殊操作
        # 工作线程将自动尝试下载并根据结果更新冷却时间
        print("所有到期的重试任务已重新加入下载队列。")

def start_retry_task():
    """在后台启动定时重试任务"""
    print(f"启动后台定时重试任务，检查间隔为 {RETRY_INTERVAL_SECONDS / 3600:.1f} 小时。")
    asyncio.create_task(retry_failed_tasks_periodically())

async def add_song_to_queue(
    song_mid: str,
    song_name: str,
    download_dir: str = "",
    playlist_mode: bool = False,
    date_folder=None,
    force: bool = False,
):
    """生产者接口：将歌曲加入下载队列

    普通下载：若该歌曲已有排队/下载中/已完成的任务，则跳过，避免重复下载。
    force=True（用户点了"重新下载"）：忽略上述跳过逻辑，并允许覆盖已存在的本地文件。
    download_dir 为歌曲的下载目录（空 = 使用默认目录）；
    playlist_mode 标记是否来自歌单下载；
    date_folder 为该歌单的"按日期建文件夹"开关（None = 沿用该歌曲上一次任务的设置）。
    """
    existing = download_tasks.get(song_mid)

    if existing and not force:
        status = existing.get("status")
        if status in ("queued", "downloading", "completed"):
            print(f"跳过加入队列: {song_name} 当前状态为 {status}")
            return False
        if status == "local_exists":
            print(f"跳过加入队列: {song_name} 本地已存在")
            return False

    # 重试/重下时若调用方没带目录或开关，沿用上一次任务的设置，避免跑到默认目录
    if existing:
        download_dir = download_dir or existing.get("download_dir", "")
        playlist_mode = playlist_mode or bool(existing.get("playlist_mode"))
        if date_folder is None:
            date_folder = existing.get("date_folder")

    download_tasks[song_mid] = {
        "status": "queued",
        "song_name": song_name,
        "quality": "",
        "progress": 0,
        "error": None,
        "download_dir": download_dir,
        "playlist_mode": playlist_mode,
        "date_folder": bool(date_folder),
        "force": force,
    }
    await _save_download_tasks()
    await song_queue.put((song_mid, song_name))
    return True
