import asyncio
import os
import time
from typing import Dict, List, Set

import aiofiles
import orjson as json

import qq_music
from tasks import add_song_to_queue
from shared_state import download_tasks, pending_completion
from download_paths import default_playlist_dir

DATA_DIR = "data"
MONITOR_FILE = os.path.join(DATA_DIR, "monitored_playlists.json")
file_lock = asyncio.Lock()
# 防止监控检查重叠执行（歌单大/网络慢时避免并发重复加队列）
_check_lock = asyncio.Lock()

# 从配置管理模块获取配置
from config import config
# 检查间隔（秒），默认为 30 分钟。配置文件里可能是字符串，需转 int
CHECK_INTERVAL_SECONDS = int(config.get("monitor.check_interval_seconds", 1800))

# 结果汇报相关
REPORT_MAX_SONGS = 50          # 汇报里最多列多少首歌单曲目
REPORT_SETTLE_TIMEOUT = 1800   # 本批超过这么久仍未跑完，也先汇报一次当前进度
REPORT_CHECK_INTERVAL = 30     # 结算检查间隔（秒）

# 确保数据目录在启动时存在
os.makedirs(DATA_DIR, exist_ok=True)

# { "playlist_id": {"title": "歌单名", "known_song_mids": ["mid1", "mid2"]} }
MonitoredPlaylists = Dict[str, Dict[str, Set[str]]]

async def _load_monitored_playlists() -> MonitoredPlaylists:
    """加载被监控的歌单列表，确保 song_mids 是集合类型"""
    async with file_lock:
        if not os.path.exists(MONITOR_FILE):
            return {}
        try:
            async with aiofiles.open(MONITOR_FILE, "rb") as f:
                content = await f.read()
                if not content:
                    return {}
                data = json.loads(content)

            if not isinstance(data, dict):
                print(f"警告: '{MONITOR_FILE}' 文件内容不是预期的字典格式，将重置为空。")
                return {}

            for playlist_id, details in data.items():
                if "known_song_mids" in details and isinstance(
                    details["known_song_mids"], list
                ):
                    details["known_song_mids"] = set(details["known_song_mids"])
            return data
        except (json.JSONDecodeError, IOError) as e:
            print(f"警告: 读取或解析 '{MONITOR_FILE}' 文件失败: {e}。将返回空监控列表。")
            return {}

async def _save_monitored_playlists(playlists: MonitoredPlaylists):
    """保存被监控的歌单列表，将集合转回列表以便JSON序列化"""
    async with file_lock:
        try:
            data_to_save = {}
            for playlist_id, details in playlists.items():
                data_to_save[playlist_id] = details.copy()
                if "known_song_mids" in data_to_save[playlist_id]:
                    data_to_save[playlist_id]["known_song_mids"] = list(
                        details["known_song_mids"]
                    )
            # orjson.dumps 返回 bytes, indent=2
            json_data = json.dumps(data_to_save, option=json.OPT_INDENT_2)
            async with aiofiles.open(MONITOR_FILE, "wb") as f:
                await f.write(json_data)
        except IOError as e:
            print(f"错误：无法保存监控列表文件: {e}")

async def toggle_monitoring(playlist_id: str) -> bool:
    """切换一个歌单的监控状态，返回当前是否在监控"""
    playlists = await _load_monitored_playlists()
    
    if playlist_id in playlists:
        # 如果已在监控，则取消监控
        del playlists[playlist_id]
        is_monitoring = False
        print(f"已取消对歌单 {playlist_id} 的监控。")
    else:
        # 如果未在监控，则开始监控
        try:
            # 获取歌单详情以存储歌单名和当前歌曲列表
            playlist_details = await qq_music.get_playlist_songs(int(playlist_id))
            if isinstance(playlist_details, list): # 假设返回的是歌曲列表
                current_mids = {song['mid'] for song in playlist_details}
                # 从用户歌单列表匹配真实歌单名
                title = f"歌单 {playlist_id}"
                try:
                    from qq_music import get_user_playlists, get_credential
                    cred = get_credential()
                    if cred:
                        user_playlists = await get_user_playlists(cred.musicid)
                        for pl in user_playlists:
                            if str(pl.get("dissid")) == str(playlist_id):
                                title = pl.get("title", title)
                                break
                except Exception as e:
                    print(f"获取歌单真实名称失败: {e}，使用 ID 作为标题")
                playlists[playlist_id] = {
                    "title": title,
                    "known_song_mids": current_mids,
                    "download_dir": "",  # 空 = 使用 <下载根目录>/<歌单名称>
                    "date_folder": False,  # 该歌单是否按日期(YYMMDD)新建文件夹
                }
                is_monitoring = True
                print(f"已开始监控歌单 {playlist_id}。当前有 {len(current_mids)} 首歌曲。")
            else:
                print(f"错误：无法获取歌单 {playlist_id} 的歌曲列表。")
                return False # 操作失败
        except Exception as e:
            print(f"错误：添加监控时无法获取歌单详情: {e}")
            return False # 操作失败

    await _save_monitored_playlists(playlists)
    return is_monitoring

async def get_monitored_playlist_ids() -> List[str]:
    """获取所有被监控的歌单ID"""
    playlists = await _load_monitored_playlists()
    return list(playlists.keys())


async def _resolve_real_titles(playlist_ids: List[str]) -> dict:
    """从用户歌单列表解析指定歌单的真实名称

    Args:
        playlist_ids: 需要解析真实名称的歌单ID列表（字符串）

    Returns:
        dict: {playlist_id(str): 真实歌单名}
    """
    real_titles = {}
    if not playlist_ids:
        return real_titles
    try:
        from qq_music import get_user_playlists, get_credential
        cred = get_credential()
        if cred:
            user_playlists = await get_user_playlists(cred.musicid)
            for pl in user_playlists:
                pid = str(pl.get("dissid"))
                if pid in playlist_ids:
                    real_titles[pid] = pl.get("title", "")
    except Exception as e:
        print(f"解析歌单真实名称失败: {e}")
    return real_titles


async def resolve_playlist_title(playlist_id) -> str:
    """解析歌单真实名称（用于默认下载目录命名）

    优先查用户歌单列表，其次用监控记录里的标题，最后退回"歌单 {id}"。
    """
    pid = str(playlist_id)
    titles = await _resolve_real_titles([pid])
    title = titles.get(pid, "")
    if title:
        return title

    playlists = await _load_monitored_playlists()
    details = playlists.get(pid) or {}
    title = details.get("title", "")
    if title and title != f"歌单 {pid}":
        return title
    return title or f"歌单 {pid}"


async def get_monitored_playlists_config():
    """获取所有已监控歌单的下载目录配置

    若歌单标题是占位格式"歌单 {ID}"，则尝试解析真实名称。
    同时返回 resolved_dir：留空时实际会使用的目录。

    Returns:
        dict: {"<playlist_id>": {"title": str, "download_dir": str, "resolved_dir": str}, ...}
    """
    playlists = await _load_monitored_playlists()

    # 收集需要解析真实名称的歌单
    placeholder_ids = []
    for playlist_id, details in playlists.items():
        title = details.get("title", "")
        if not title or title == f"歌单 {playlist_id}":
            placeholder_ids.append(str(playlist_id))

    # 通过用户歌单列表解析真实名称
    real_titles = await _resolve_real_titles(placeholder_ids)

    result = {}
    for playlist_id, details in playlists.items():
        pid = str(playlist_id)
        title = details.get("title", "")
        if not title or title == f"歌单 {playlist_id}":
            title = real_titles.get(pid) or title or f"歌单 {playlist_id}"
        download_dir = details.get("download_dir", "")
        result[pid] = {
            "title": title,
            "download_dir": download_dir,
            "resolved_dir": download_dir or default_playlist_dir(title, pid),
            "date_folder": bool(details.get("date_folder", False)),
        }
    return result


async def update_monitored_playlists_config(config_data: dict):
    """批量更新已监控歌单的下载配置

    Args:
        config_data: {"<playlist_id>": {"download_dir": str, "date_folder": bool}, ...}

    Returns:
        dict: 更新后的完整配置
    """
    playlists = await _load_monitored_playlists()
    for playlist_id, settings in config_data.items():
        if playlist_id not in playlists:
            continue
        download_dir = settings.get("download_dir", "")
        if isinstance(download_dir, str):
            playlists[playlist_id]["download_dir"] = download_dir.strip()
        if "date_folder" in settings:
            playlists[playlist_id]["date_folder"] = _as_bool(settings["date_folder"])

    await _save_monitored_playlists(playlists)
    return await get_monitored_playlists_config()


def _as_bool(value) -> bool:
    """把前端传来的各种写法统一成布尔值"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return bool(value)

async def check_playlists_for_updates():
    """检查所有被监控的歌单是否有更新，并自动下载新歌曲"""
    # 防重叠执行：上一次检查未完成时跳过本次
    if _check_lock.locked():
        print("上一次歌单检查尚未完成，跳过本次检查。")
        return

    async with _check_lock:
        await _do_check_playlists()

async def _do_check_playlists():
    """实际执行歌单检查（在防重入锁内运行）"""
    print("开始检查监控的歌单是否有更新...")
    await qq_music.auth_completed.wait()
    if not qq_music.is_login_valid():
        print("检查更新失败：用户未登录。")
        return

    playlists = await _load_monitored_playlists()
    if not playlists:
        print("没有正在监控的歌单。")
        return

    updated_playlists = playlists.copy()

    # 预先解析所有需要真实名称的歌单（占位标题的）
    placeholder_ids = [
        str(pid)
        for pid, d in playlists.items()
        if not d.get("title") or d.get("title") == f"歌单 {pid}"
    ]
    real_titles = await _resolve_real_titles(placeholder_ids)

    for playlist_id, details in playlists.items():
        # 解析真实歌单名（占位则用解析结果）
        title = details.get("title", f"歌单 {playlist_id}")
        if not title or title == f"歌单 {playlist_id}":
            title = real_titles.get(str(playlist_id)) or title

        try:
            print(f"正在检查歌单: {title}...")
            # 传入 no_cache=True 来绕过 API 缓存
            current_songs = await qq_music.get_playlist_songs(int(playlist_id), no_cache=True)
            if not isinstance(current_songs, list):
                print(f"警告：无法获取歌单 {playlist_id} 的当前歌曲列表，跳过。")
                continue

            current_mids = {song['mid'] for song in current_songs}
            known_mids = details.get("known_song_mids", set())

            new_mids = current_mids - known_mids

            if new_mids:
                print(f"歌单 '{title}' 发现 {len(new_mids)} 首新歌曲！")
                new_song_dicts = []
                # 歌单下载位置留空 → 默认 <下载根目录>/<歌单名称>
                playlist_dir = details.get("download_dir", "") or default_playlist_dir(title, playlist_id)
                # 该歌单自己的"按日期建文件夹"开关
                date_folder = bool(details.get("date_folder", False))

                # 完整歌单快照（用于结算后的结果汇报，最多 REPORT_MAX_SONGS 首）
                playlist_snapshot = [
                    {
                        "mid": song.get("mid"),
                        "name": song.get("name", "未知歌曲"),
                        "singer_names": [s.get("name", "") for s in song.get("singer", [])],
                    }
                    for song in current_songs[:REPORT_MAX_SONGS]
                ]

                batch_mids = set()
                for song in current_songs:
                    if song['mid'] in new_mids:
                        song_name = f"{song['name']} - {', '.join(s['name'] for s in song['singer'])}"
                        print(f"  -> 正在将新歌曲 '{song_name}' 加入下载队列...")
                        # 将新歌放入任务队列，而不是直接下载
                        await add_song_to_queue(
                            song['mid'],
                            song_name,
                            download_dir=playlist_dir,
                            playlist_mode=True,
                            date_folder=date_folder,
                        )
                        batch_mids.add(song['mid'])
                        new_song_dicts.append(song)

                # 更新该歌单的已知歌曲列表
                updated_playlists[playlist_id]["known_song_mids"].update(new_mids)

                # 通知①：发现更新（含新增数量与歌单总数）
                if new_song_dicts:
                    from notification import notification_manager
                    await notification_manager.send_playlist_update_notification(
                        title, new_song_dicts, total_count=len(current_songs)
                    )
                    # 登记待汇报批次：这批下载全部结束后，发送完整歌单结果
                    pending_completion[playlist_id] = {
                        "title": title,
                        "playlist_songs": playlist_snapshot,
                        "batch_mids": batch_mids,
                        "total_count": len(current_songs),
                        "truncated": len(current_songs) > REPORT_MAX_SONGS,
                        "dir": playlist_dir,
                        "queued_at": time.time(),
                    }

            # 同步 known_song_mids：移除歌单中已不存在的歌曲，
            # 避免"删除又加回"的歌曲被当成新歌重复下载
            removed_mids = known_mids - current_mids
            if removed_mids:
                updated_playlists[playlist_id]["known_song_mids"] = known_mids - removed_mids
                print(f"歌单 '{title}' 有 {len(removed_mids)} 首歌曲已移除，同步已知列表。")
            else:
                print(f"歌单 '{title}' 没有发现新歌曲。")

        except Exception as e:
            print(f"错误：检查歌单 {playlist_id} 更新时出错: {e}")
            continue

    await _save_monitored_playlists(updated_playlists)

    # 检查"歌单更新新增歌曲"是否有已下载完成的，发送汇总通知
    await _check_pending_completion()

    print("歌单更新检查完成。")


def _build_report_entries(state: dict):
    """按歌单顺序整理每首歌的下载结果与未下载原因

    Returns:
        (entries, stats)
    """
    from local_files import DirIndex, describe_file, human_size

    playlist_songs = state.get("playlist_songs") or []
    batch_mids = state.get("batch_mids") or set()
    playlist_dir = state.get("dir") or ""
    dir_index = DirIndex(playlist_dir) if playlist_dir and os.path.isdir(playlist_dir) else None

    entries = []
    stats = {}
    for index, song in enumerate(playlist_songs, 1):
        mid = song.get("mid")
        label = f"{song.get('name', '未知歌曲')} - {', '.join(song.get('singer_names') or [])}".strip(" -")
        task = download_tasks.get(mid) or {}
        status = task.get("status")
        detail = ""

        if status == "completed":
            kind = "completed"
            detail = task.get("quality") or ""
        elif status == "local_exists":
            kind = "local_exists"
            detail = task.get("quality") or ""
            size = task.get("file_size") or 0
            if size:
                detail = f"{detail}，{human_size(size)}" if detail else human_size(size)
        elif status == "failed":
            kind = "failed"
            detail = task.get("error") or "未知错误"
        elif status == "waiting_for_retry":
            kind = "waiting"
            detail = task.get("error") or "账号超出下载限制"
        elif status in ("queued", "downloading"):
            kind = "pending"
            detail = f"{task.get('progress', 0)}%" if status == "downloading" else ""
        elif status == "cancelled":
            kind = "cancelled"
        else:
            # 没有任务记录：直接看目标目录里到底有没有这首歌
            local = None
            if dir_index is not None:
                found = dir_index.find(label)
                if found:
                    local = describe_file(found)
            if local:
                kind = "local_exists"
                detail = local.get("quality") or ""
            else:
                kind = "unknown"

        stats[kind] = stats.get(kind, 0) + 1
        entries.append({
            "index": index,
            "label": label,
            "status": kind,
            "detail": detail,
            "in_batch": mid in batch_mids,
        })
    return entries, stats


async def _check_pending_completion():
    """检查待汇报的批次：本次下载跑完后，发送完整歌单下载结果

    判定"跑完"：该批次的歌曲都不再处于排队中/下载中。
    超过 REPORT_SETTLE_TIMEOUT 仍未跑完时，也先汇报一次当前进度。
    """
    if not pending_completion:
        return

    from notification import notification_manager

    for playlist_id, state in list(pending_completion.items()):
        batch_mids = state.get("batch_mids") or set()
        running = [
            mid for mid in batch_mids
            if (download_tasks.get(mid) or {}).get("status") in ("queued", "downloading")
        ]
        elapsed = time.time() - state.get("queued_at", 0)
        if running and elapsed < REPORT_SETTLE_TIMEOUT:
            continue

        entries, stats = _build_report_entries(state)
        title = state.get("title", f"歌单 {playlist_id}")
        print(
            f"歌单 '{title}' 本次下载已结束，汇报结果: "
            + "、".join(f"{k}={v}" for k, v in stats.items())
        )
        await notification_manager.send_playlist_report_notification(
            title,
            entries,
            stats,
            total_count=state.get("total_count", len(entries)),
            batch_count=len(batch_mids),
            truncated=bool(state.get("truncated")),
            still_running=len(running),
        )
        pending_completion.pop(playlist_id, None)


async def pending_report_task():
    """后台任务：定期检查是否有批次已下载结束、需要汇报结果"""
    while True:
        try:
            await _check_pending_completion()
        except Exception as e:
            print(f"检查歌单下载结果时出错: {e}")
        await asyncio.sleep(REPORT_CHECK_INTERVAL)


async def monitoring_task():
    """后台监控任务，定期运行"""
    while True:
        await check_playlists_for_updates()
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)

def start_monitoring_task():
    """在后台启动监控任务"""
    print("启动后台歌单监控任务...")
    asyncio.create_task(monitoring_task())
    print(f"启动歌单下载结果汇报任务，检查间隔 {REPORT_CHECK_INTERVAL} 秒。")
    asyncio.create_task(pending_report_task())
