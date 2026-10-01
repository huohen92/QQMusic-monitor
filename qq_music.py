import asyncio
import os
from typing import Optional

from qqmusic_api import Client
from qqmusic_api.algorithms import qrc_decrypt
from qqmusic_api.models.login import PhoneLoginEvents, QRCodeLoginEvents, QRLoginType
from qqmusic_api.modules.login_utils import PhoneLoginSession, QRCodeLoginSession
from qqmusic_api.modules.song import SongFileInfo, SongFileType
from qqmusic_api.modules.search import SearchType

from utils import (
    load_credentials,
    save_credentials,
    check_login_status as check_credential_status,
    CREDENTIALS_FILE_PATH,
    DEVICE_FILE_PATH,
)

# --- 全局状态和会话 ---
# 一个全局的、可复用的 Client 实例
# 我们将在应用启动时初始化它，在关闭时销毁它
global_client: Optional[Client] = None

# 二维码登录会话，用于轮询扫码状态
login_session: Optional[QRCodeLoginSession] = None
auth_completed = asyncio.Event()

# 从 utils 复用 API 冷却时间存取（新版 Credential 为冻结 pydantic 模型，无法动态附加属性）
from utils import get_cooldown_until, set_cooldown_until  # noqa: E402


def get_credential():
    """从文件加载凭证，这是唯一可靠的状态来源"""
    return load_credentials()


def is_login_valid() -> bool:
    """检查登录是否有效"""
    cred = get_credential()
    return cred is not None and cred.musicid is not None and cred.musicid != 0


def initialize_qqmusic_session(cred=None):
    """
    创建并设置全局的 qqmusic-api Client。
    如果提供了凭证对象，则直接使用它；否则，从文件加载。
    """
    global global_client
    credential = cred if cred else get_credential()
    # 持久化设备指纹，保证 qimei / 设备信息在重启后保持一致
    global_client = Client(credential=credential, device_path=DEVICE_FILE_PATH)


async def close_qqmusic_session():
    """关闭全局客户端"""
    global global_client
    if global_client:
        await global_client.close()
        global_client = None


# --- 音质配置 ---
QUALITY_MAP = {
    SongFileType.MASTER: (".flac", "臻品母带"),
    SongFileType.ATMOS_51: (".flac", "臻品全景声 (5.1)"),
    SongFileType.ATMOS_2: (".flac", "臻品全景声 (Stereo)"),
    SongFileType.FLAC: (".flac", "SQ无损音质"),
    SongFileType.OGG_640: (".ogg", "极高音质"),
    SongFileType.OGG_320: (".ogg", "HQ高品音质"),
    SongFileType.MP3_320: (".mp3", "HQ较高音质"),
    SongFileType.ACC_192: (".m4a", "较高音质"),
    SongFileType.OGG_192: (".ogg", "标准音质"),
    SongFileType.MP3_128: (".mp3", "标准音质"),
    SongFileType.ACC_96: (".m4a", "流畅音质"),
    SongFileType.OGG_96: (".ogg", "流畅音质"),
    SongFileType.ACC_48: (".m4a", "超低音质"),
}
QUALITY_ORDER = list(QUALITY_MAP.keys())

# 无损及以上：开启"优先 MP3"时这些档位不受影响，避免为了格式把无损降级
LOSSLESS_TYPES = (
    SongFileType.MASTER,
    SongFileType.ATMOS_51,
    SongFileType.ATMOS_2,
    SongFileType.FLAC,
)
# 原生 MP3 档位
MP3_TYPES = (SongFileType.MP3_320, SongFileType.MP3_128)


def get_quality_order():
    """实际下载时尝试的音质顺序

    默认就是 QUALITY_ORDER；开启 download.prefer_mp3 时，把原生 MP3 两档提到
    OGG/ACC 之前：
        母带/全景声/FLAC（不变） → MP3_320 → MP3_128 → OGG_640 → OGG_320 → ...
    这样"该退而求其次"时先拿 QQ 原生 MP3（无需二次转码、无额外音质损失），
    只有这首歌完全没有 MP3 时才保留 .ogg。
    """
    from config import config

    if not config.get("download.prefer_mp3", False):
        return list(QUALITY_ORDER)

    lossless = [q for q in QUALITY_ORDER if q in LOSSLESS_TYPES]
    mp3 = [q for q in QUALITY_ORDER if q in MP3_TYPES]
    others = [q for q in QUALITY_ORDER if q not in LOSSLESS_TYPES and q not in MP3_TYPES]
    return lossless + mp3 + others


# --- 核心函数 ---

async def initialize_from_cookie():
    """从 cookie 文件加载并验证凭证，并设置认证完成事件"""
    try:
        cred = get_credential()
        initialize_qqmusic_session(cred)  # 使用加载的凭证初始化
        if cred and cred.musicid:
            print("已从文件加载凭证，正在验证有效性...")
            is_valid, message = await check_credential_status(cred)
            if is_valid:
                print(message)
                try:
                    print("凭证有效，尝试刷新 Cookie 以确保会话最新...")
                    new_cred = await global_client.login.refresh_credential(cred)
                    save_credentials(new_cred)
                    # 使用刷新后的凭证重新初始化客户端
                    initialize_qqmusic_session(new_cred)
                    print("Cookie 刷新成功。")
                except Exception as e:
                    print(f"刷新 Cookie 失败: {e}。将继续使用现有凭证，但这可能导致认证问题。")
            else:
                print(message)
                if os.path.exists(CREDENTIALS_FILE_PATH):
                    os.remove(CREDENTIALS_FILE_PATH)
                initialize_qqmusic_session()
        else:
            print("未找到本地凭证文件。")
    except Exception as e:
        print(f"初始化凭证时发生错误: {e}")
    finally:
        auth_completed.set()


async def get_login_qrcode(login_type: str = "QQ"):
    """获取登录二维码

    Args:
        login_type: 登录类型，可选值："QQ" 或 "WX"

    Returns:
        bytes: 二维码图片数据
    """
    global login_session
    initialize_qqmusic_session()  # 确保客户端存在

    login_type_enum = QRLoginType.QQ if login_type == "QQ" else QRLoginType.WX
    # 每个请求创建一个新的登录会话（保持短超时，前端自行轮询状态）
    login_session = QRCodeLoginSession(
        global_client.login,
        login_type_enum,
        interval=1.5,
        timeout_seconds=180.0,
    )
    qr = await login_session.get_qrcode()
    return qr.data


async def check_login_status():
    """检查二维码扫描状态（每次调用查询一次，供前端轮询）"""
    global login_session
    if not login_session:
        return {"status": "error", "message": "请先获取二维码"}

    try:
        qr = login_session.qrcode
        if qr is None:
            return {"status": "error", "message": "请先获取二维码"}

        result = await global_client.login.check_qrcode(qr)
        event = result.event

        if event == QRCodeLoginEvents.DONE:
            cred = result.credential
            if cred is not None:
                save_credentials(cred)
                # 使用新鲜的凭证对象重新初始化客户端
                initialize_qqmusic_session(cred)
                return {"status": "success", "message": "登录成功", "is_success": True}

        message_map = {
            QRCodeLoginEvents.SCAN: "等待扫描二维码",
            QRCodeLoginEvents.CONF: "已扫码，请在手机上确认登录",
            QRCodeLoginEvents.TIMEOUT: "二维码已过期",
            QRCodeLoginEvents.REFUSE: "您已拒绝登录",
        }
        return {
            "status": event.name.lower(),
            "message": message_map.get(event, "未知状态"),
            "is_success": False,
        }
    except Exception as e:
        print(f"检查二维码登录状态失败: {e}")
        return {"status": "error", "message": f"登录失败: {e}", "is_success": False}


# --- 手机号登录相关函数 ---

async def send_sms_code(phone: str, captcha_code: str = None, country_code: int = 86):
    """发送验证码到手机

    Args:
        phone: 手机号
        captcha_code: 验证码（新版库不需要）
        country_code: 国家码，默认86（中国）

    Returns:
        dict: 发送结果
    """
    try:
        initialize_qqmusic_session()
        phone_session = PhoneLoginSession(global_client.login, phone, country_code)
        result = await phone_session.send_authcode()
        if result.event == PhoneLoginEvents.SEND:
            return {"status": "success", "message": "验证码发送成功"}
        elif result.event == PhoneLoginEvents.CAPTCHA:
            return {"status": "captcha_required", "message": "需要验证码验证", "captcha_url": result.info}
        elif result.event == PhoneLoginEvents.FREQUENCY:
            return {"status": "error", "message": "发送频率过高，请稍后重试"}
        else:
            return {"status": "error", "message": "验证码发送失败"}
    except Exception as e:
        print(f"发送验证码失败: {e}")
        return {"status": "error", "message": f"发送验证码失败: {str(e)}"}


async def phone_login(phone: str, auth_code: str, country_code: int = 86):
    """使用手机号和验证码登录

    Args:
        phone: 手机号
        auth_code: 验证码
        country_code: 国家码，默认86（中国）

    Returns:
        dict: 登录结果
    """
    try:
        initialize_qqmusic_session()
        phone_session = PhoneLoginSession(global_client.login, phone, country_code)
        cred = await phone_session.authorize(auth_code)

        if not cred:
            return {"status": "error", "message": "登录失败，无效的验证码"}

        save_credentials(cred)
        # 使用新鲜的凭证对象重新初始化客户端
        initialize_qqmusic_session(cred)
        print("手机号登录成功，凭证已保存。")
        return {"status": "success", "message": "登录成功"}
    except Exception as e:
        print(f"手机号登录失败: {e}")
        return {"status": "error", "message": f"登录失败: {str(e)}"}


async def get_user_playlists(user_id: int):
    """获取用户所有歌单，包括自建和收藏的"""
    cred = get_credential()
    if not cred or not cred.encrypt_uin:
        raise ValueError("用户未登录或凭证无效")

    euin = cred.encrypt_uin
    created_songlists_data = await global_client.user.get_created_songlist(user_id)
    fav_song_data = await global_client.user.get_fav_song(euin, num=1)
    fav_songlists_data = await global_client.user.get_fav_songlist(euin, num=100)

    # 自建歌单
    created_songlists = []
    for pl in created_songlists_data.playlists:
        created_songlists.append({
            "dissid": pl.id,
            "dirid": pl.dirid,
            "picurl": pl.picurl,
            "title": pl.title,
            "subtitle": f"{pl.songnum}首",
        })

    # 收藏歌单
    favorite_songlists = []
    for pl in fav_songlists_data.playlists:
        favorite_songlists.append({
            "dissid": pl.id,
            "dirid": pl.dirid,
            "picurl": pl.picurl,
            "title": pl.title,
            "subtitle": f"{pl.songnum}首",
        })

    # 我喜欢歌单
    my_favorites_playlist = {
        "dissid": "201",
        "title": "我喜欢",
        "subtitle": f"{fav_song_data.total}首",
        "picurl": "",
        "dirid": 201,
    }

    all_playlists = []
    my_favorites_playlist['type'] = 'favorite'
    all_playlists.append(my_favorites_playlist)

    for pl in created_songlists:
        pl['type'] = 'created'
        all_playlists.append(pl)

    for pl in favorite_songlists:
        pl['type'] = 'favorite'
        all_playlists.append(pl)

    return all_playlists


def _song_to_dict(song):
    """将 pydantic Song 模型转为前端/后端使用的普通字典"""
    return {
        "mid": song.mid,
        "id": song.id,
        "name": song.name,
        "singer": [
            {"name": s.name, "mid": s.mid, "id": s.id} for s in song.singer
        ],
        # album.mid 用于前端拼封面地址（数据本来就在接口返回里，不额外请求）
        "album": {"name": song.album.name, "mid": song.album.mid} if song.album else {},
        "interval": getattr(song, "interval", 0),
    }


async def search_song(keyword: str, page: int = 1, num: int = 10):
    """根据关键词搜索歌曲"""
    # 搜索可以不需要凭证
    result = await global_client.search.search_by_type(
        keyword, SearchType.SONG, page=page, num=num
    )
    return [_song_to_dict(song) for song in result.song]


async def get_playlist_songs(playlist_id: int, no_cache: bool = False):
    """获取歌单中的歌曲，特殊处理'我喜欢'歌单

    使用分页迭代拉取全部歌曲，避免单页上限（5000）导致漏歌。
    """
    cred = get_credential()
    if not cred:
        raise ValueError("用户未登录")

    songs = []
    if str(playlist_id) == "201":
        fav_req = global_client.user.get_fav_song(cred.encrypt_uin, num=100, page=1)
        pager = fav_req.paginate()
        async for page in pager:
            songs.extend(page.songs)
    else:
        detail_req = global_client.songlist.get_detail(songlist_id=playlist_id, num=100, page=1)
        pager = detail_req.paginate()
        async for page in pager:
            songs.extend(page.songs)

    return [_song_to_dict(song) for song in songs]


async def get_song_by_mid(song_mid: str):
    """根据歌曲 mid 获取完整元数据，用于标签写入

    Returns:
        dict: 含 name/singer/album/track/year/cover_url 的字典；失败返回 None
    """
    if not global_client:
        initialize_qqmusic_session()
    try:
        detail = await global_client.song.get_detail(song_mid)
        track = detail.track
        return {
            "name": track.name,
            "singer": [s.name for s in track.singer],
            "album": track.album.name if track.album else "",
            "track": track.index_album,
            "year": track.time_public[:4] if track.time_public else "",
            "cover_url": track.cover_url(500) if track.album.mid or track.album.pmid else "",
        }
    except Exception as e:
        print(f"获取歌曲详情失败 {song_mid}: {e}")
        return None


async def get_user_info():
    """获取当前登录用户的昵称和头像

    Returns:
        dict: 含 nick_name / head_url 的字典；未登录或失败返回 None
    """
    cred = get_credential()
    if not cred or not cred.encrypt_uin:
        return None
    if not global_client:
        initialize_qqmusic_session(cred)
    try:
        data = await global_client.user.get_music_gene(cred.encrypt_uin)
        card = data.user_info_card
        return {
            "nick_name": card.nick_name,
            "head_url": card.head_url,
        }
    except Exception as e:
        print(f"获取用户信息失败: {e}")
        return None


async def get_song_lyrics(song_mid: str):
    """获取歌曲歌词（普通/逐字/翻译）

    - qrc=False 得到普通 LRC（lyric）与翻译 LRC（trans）
    - qrc=True 得到逐字 QRC（XML），转换为标准 LRC 存入 qrc 字段

    使用 qqmusic-api-python 的公开接口 lyric.get_lyric()；
    返回的 GetLyricResponse 模型内部已自动解密歌词（见 models/lyric.py）。

    Returns:
        dict: 含 lyric(普通LRC) / qrc(逐字LRC) / trans(翻译LRC) 的字典；失败返回 None
    """
    if not global_client:
        initialize_qqmusic_session()
    try:
        def _field(obj, name):
            """兼容模型对象与 dict 两种返回形式"""
            if obj is None:
                return ""
            if isinstance(obj, dict):
                value = obj.get(name, "")
            else:
                value = getattr(obj, name, "")
            return value if isinstance(value, str) else ""

        def _plain(value):
            """库已自动解密；这里只兜底处理仍是密文、或旧版本未解密的情况"""
            if not value or not isinstance(value, str):
                return ""
            if value.lstrip()[:1] in ("[", "<"):
                return value  # 已是明文 LRC / QRC XML
            try:
                return qrc_decrypt(value)
            except Exception:
                return value

        # 普通 + 翻译
        data_normal = await global_client.lyric.get_lyric(song_mid, qrc=False, trans=True)
        lyric = _plain(_field(data_normal, "lyric"))
        trans = _plain(_field(data_normal, "trans"))
        if not lyric.startswith("[") and not trans:
            # 尝试仅拿普通歌词
            data_normal2 = await global_client.lyric.get_lyric(song_mid, qrc=False, trans=False)
            lyric = _plain(_field(data_normal2, "lyric")) or lyric

        # 逐字歌词
        qrc = ""
        try:
            data_qrc = await global_client.lyric.get_lyric(song_mid, qrc=True, trans=False)
            qrc_xml = _plain(_field(data_qrc, "lyric"))
            if qrc_xml.strip().startswith("<"):
                qrc = _convert_qrc_to_lrc(qrc_xml)
        except Exception as e:
            print(f"获取逐字歌词失败: {e}")

        return {"lyric": lyric, "qrc": qrc, "trans": trans}
    except Exception as e:
        print(f"获取歌词失败 {song_mid}: {e}")
        return None


def _convert_qrc_to_lrc(qrc_xml: str) -> str:
    """将逐字歌词 QRC（XML）转换为标准 LRC 文本

    QRC 行格式: [start_ms,dur_ms]文字(字起始,字时长)...
    """
    import re

    m = re.search(r'LyricContent="(.*?)"', qrc_xml, re.DOTALL)
    if not m:
        return ""
    content = m.group(1)
    lines = []
    for line in content.split("\n"):
        line = line.strip()
        if not line:
            continue
        lm = re.match(r"\[(\d+),\d+\](.*)", line)
        if not lm:
            lines.append(line)
            continue
        start_ms = int(lm.group(1))
        text = re.sub(r"\([^)]*\)", "", lm.group(2))
        mm, ss_ms = divmod(start_ms, 60000)
        ss, ms_rest = divmod(ss_ms, 1000)
        lines.append(f"[{mm:02d}:{ss:02d}.{ms_rest // 10:02d}]{text}")
    return "\n".join(lines)


async def get_song_download_url(song_mid: str):
    """按顺序获取最佳音质的歌曲下载URL"""
    cred = get_credential()
    if not cred:
        print("用户未登录或凭证无效，无法获取下载链接。")
        return None

    # global_client 应该已经初始化，但这是保险
    if not global_client:
        initialize_qqmusic_session(cred)

    # 获取 CDN 调度信息
    cdn_dispatch = await global_client.song.get_cdn_dispatch()
    cdn = cdn_dispatch.sip[0] if cdn_dispatch.sip else "https://isure.stream.qqmusic.qq.com/"

    for quality_enum in get_quality_order():
        try:
            data = await global_client.song.get_song_urls(
                [SongFileInfo(mid=song_mid, file_type=quality_enum)]
            )
            url = None
            for info in data.data:
                if info.mid == song_mid and info.purl:
                    url = cdn + info.purl
                    break

            if url:
                extension, quality_name = QUALITY_MAP[quality_enum]
                print(f"成功获取音质 {quality_name} 的链接。")
                return {
                    "url": url,
                    "quality": quality_name,
                    "extension": extension,
                    "enum_name": quality_enum.name,
                }
        except Exception as e:
            print(f"尝试获取音质 {quality_enum.name} 失败: {e}")
            continue

    print(f"未能获取歌曲 {song_mid} 的任何下载链接。")
    return None


async def get_playback_url(song_mid: str):
    """获取网页播放用的音频 URL

    优先 MP3_320（浏览器兼容性最好），失败降级 MP3_128。

    Returns:
        dict: 含 url/quality/extension 的字典；失败返回 None
    """
    cred = get_credential()
    if not cred:
        print("用户未登录或凭证无效，无法获取播放链接。")
        return None

    if not global_client:
        initialize_qqmusic_session(cred)

    cdn_dispatch = await global_client.song.get_cdn_dispatch()
    cdn = cdn_dispatch.sip[0] if cdn_dispatch.sip else "https://isure.stream.qqmusic.qq.com/"

    for quality_enum in (SongFileType.MP3_320, SongFileType.MP3_128):
        try:
            data = await global_client.song.get_song_urls(
                [SongFileInfo(mid=song_mid, file_type=quality_enum)]
            )
            url = None
            for info in data.data:
                if info.mid == song_mid and info.purl:
                    url = cdn + info.purl
                    break
            if url:
                extension, quality_name = QUALITY_MAP[quality_enum]
                return {"url": url, "quality": quality_name, "extension": extension}
        except Exception as e:
            print(f"获取播放音质 {quality_enum.name} 失败: {e}")
            continue

    print(f"未能获取歌曲 {song_mid} 的播放链接。")
    return None
