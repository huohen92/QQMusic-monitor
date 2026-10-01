document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Selectors ---
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const loginStatus = document.getElementById('login-status');
    const qrcodeContainer = document.getElementById('qrcode-container');
    const qrcodeImg = document.getElementById('qrcode-img');
    const playlistsContainer = document.getElementById('playlists');
    const songListContainer = document.getElementById('song-list');
    const ongoingDownloadsList = document.getElementById('ongoing-downloads');
    const completedDownloadsList = document.getElementById('completed-downloads');
    const selectAllCompletedContainer = document.getElementById('select-all-completed-container');
    const selectAllCompletedCheckbox = document.getElementById('select-all-completed-checkbox');
    const completedActions = document.getElementById('completed-actions');

    // New selectors for ongoing tasks
    const selectAllOngoingContainer = document.getElementById('select-all-ongoing-container');
    const selectAllOngoingCheckbox = document.getElementById('select-all-ongoing-checkbox');
    const ongoingActions = document.getElementById('ongoing-actions');

    let loginCheckInterval;
    let currentTasks = {}; // 全局变量，存储最新的任务状态
    let apiCooldownInterval; // 用于API冷却倒计时的计时器

    // 当前正在浏览的歌单：歌单页里单曲下载也要按该歌单的目标目录保存
    let currentPlaylistId = null;
    let currentPlaylistName = '';
    const playlistTitles = {}; // dissid -> 歌单名

    // 已完成任务在列表中最多渲染的条数（历史仍保存在文件/内存中，仅限制 DOM 渲染量）
    const MAX_COMPLETED_RENDER = 100;

    // --- Initial Setup ---
    checkInitialAuth();
    // Restore polling for all tasks
    setInterval(updateDownloadStatus, 2000);
    updateDownloadStatus(); // Initial call
    
    // 配置页面初始化
    setupConfigPage();

    // --- Event Listeners ---
    document.querySelectorAll('.login-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const loginType = e.target.dataset.type;
            handleLoginClick(loginType);
        });
    });
    logoutBtn.addEventListener('click', handleLogoutClick);
    
    // 手机号登录相关事件
    document.getElementById('send-code-btn').addEventListener('click', handleSendCode);
    document.getElementById('phone-login-btn').addEventListener('click', handlePhoneLogin);
    document.getElementById('back-to-qrcode-btn').addEventListener('click', backToQrcode);

    // 搜索歌曲事件
    const songSearchInput = document.getElementById('song-search-input');
    const songSearchBtn = document.getElementById('song-search-btn');
    songSearchBtn.addEventListener('click', () => searchSongs(songSearchInput.value.trim()));
    songSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchSongs(songSearchInput.value.trim());
        }
    });
    songSearchInput.addEventListener('input', () => {
        if (songSearchInput.value.trim() === '') {
            // 清空搜索时回到歌单默认提示
            songListContainer.innerHTML = '<p>请从左侧选择一个歌单。</p>';
            allSongs = [];
            loadedSongsCount = 0;
            songListContainer.onscroll = null;
        }
    });
    
    // 手机号登录按钮点击事件
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('phone-login-btn')) {
            e.preventDefault();
            showPhoneLogin();
        }
    });
    
    // 为登录按钮添加手机号登录切换
    document.getElementById('login-btn').addEventListener('click', function(e) {
        // 只有当按钮不是下拉触发状态时，才显示手机号登录选项
        if (!e.target.classList.contains('dropdown-toggle')) {
            e.preventDefault();
            showPhoneLogin();
        }
    });

    // --- Functions ---

    async function handleLoginClick(loginType = 'QQ') {
        loginStatus.textContent = '正在获取二维码...';
        try {
            const response = await fetch(`/api/login/qrcode?login_type=${loginType}`);
            const data = await response.json();
            if (data.qrcode) {
                qrcodeImg.src = data.qrcode;
                qrcodeContainer.style.display = 'block';
                loginStatus.textContent = `请使用${loginType === 'QQ' ? 'QQ' : '微信'}扫描二维码`;
                loginCheckInterval = setInterval(checkLoginStatus, 2000);
            } else {
                loginStatus.textContent = '获取二维码失败，请重试。';
            }
        } catch (error) {
            console.error('获取二维码失败:', error);
            loginStatus.textContent = '获取二维码失败，请查看控制台了解详情。';
        }
    }

    async function checkLoginStatus() {
        try {
            const response = await fetch('/api/login/status');
            const data = await response.json();
            loginStatus.textContent = data.message;
            if (data.is_success) {
                clearInterval(loginCheckInterval);
                loginStatus.textContent = '登录成功！';
                loginBtn.style.display = 'none';
                logoutBtn.style.display = 'inline-block';
                qrcodeContainer.style.display = 'none';
                loadUserInfo();
                await getUserPlaylists();
            } else if (data.status === 'timeout') {
                clearInterval(loginCheckInterval);
                loginStatus.textContent = '二维码已过期，请重新获取。';
                loginBtn.disabled = false;
                qrcodeContainer.style.display = 'none';
            }
        } catch (error) {
            console.error('检查登录状态失败:', error);
            clearInterval(loginCheckInterval);
            loginStatus.textContent = '检查登录状态时出错。';
            loginBtn.disabled = false;
        }
    }

    async function handleLogoutClick() {
        try {
            await fetch('/api/logout', { method: 'POST' });
            window.location.reload();
        } catch (error) {
            console.error('退出登录失败:', error);
        }
    }
    
    // --- 手机号登录相关函数 --- 
    
    function showPhoneLogin() {
        // 隐藏二维码登录容器，显示手机号登录容器
        document.getElementById('qrcode-container').style.display = 'none';
        document.getElementById('phone-login-container').style.display = 'block';
        // 更新登录状态文本
        document.getElementById('login-status').textContent = '请使用手机号登录';
    }
    
    function backToQrcode() {
        // 隐藏手机号登录容器，显示二维码登录容器
        document.getElementById('phone-login-container').style.display = 'none';
        document.getElementById('qrcode-container').style.display = 'none';
        // 更新登录状态文本
        document.getElementById('login-status').textContent = '正在检查登录状态...';
    }
    
    async function handleSendCode() {
        const phoneNumber = document.getElementById('phone-number').value;
        const sendCodeBtn = document.getElementById('send-code-btn');
        
        if (!phoneNumber || phoneNumber.length !== 11) {
            uiAlert('请输入有效的手机号');
            return;
        }
        
        try {
            sendCodeBtn.disabled = true;
            sendCodeBtn.textContent = '发送中...';
            
            const response = await fetch(`/api/login/send-code?phone=${encodeURIComponent(phoneNumber)}`, {
                method: 'POST'
            });
            
            const data = await response.json();
            if (data.status === 'success') {
                uiAlert(data.message);
                // 倒计时60秒
                let countdown = 60;
                sendCodeBtn.textContent = `${countdown}秒后重新发送`;
                
                const timer = setInterval(() => {
                    countdown--;
                    sendCodeBtn.textContent = `${countdown}秒后重新发送`;
                    if (countdown <= 0) {
                        clearInterval(timer);
                        sendCodeBtn.disabled = false;
                        sendCodeBtn.textContent = '发送验证码';
                    }
                }, 1000);
            } else if (data.status === 'captcha_required') {
                // 需要验证码验证，在新窗口打开
                openCaptchaInNewWindow(data.captcha_url);
                sendCodeBtn.disabled = false;
                sendCodeBtn.textContent = '发送验证码';
            } else {
                uiAlert(data.message);
                sendCodeBtn.disabled = false;
                sendCodeBtn.textContent = '发送验证码';
            }
        } catch (error) {
            console.error('发送验证码失败:', error);
            uiAlert('发送验证码失败，请稍后重试');
            sendCodeBtn.disabled = false;
            sendCodeBtn.textContent = '发送验证码';
        }
    }
    
    function openCaptchaInNewWindow(captchaUrl) {
        // 在新窗口打开验证码
        window.open(captchaUrl, '_blank', 'width=500,height=600,left=200,top=100');
        
        // 显示友好的提示
        uiAlert('验证码窗口已在新窗口打开\n\n请在新窗口完成验证码验证，验证成功后请返回此页面并再次点击"发送验证码"按钮');
    }
    
    async function handlePhoneLogin() {
        const phoneNumber = document.getElementById('phone-number').value;
        const authCode = document.getElementById('auth-code').value;
        const phoneLoginBtn = document.getElementById('phone-login-btn');
        
        if (!phoneNumber || phoneNumber.length !== 11) {
            uiAlert('请输入有效的手机号');
            return;
        }
        
        if (!authCode || authCode.length !== 6) {
            uiAlert('请输入6位验证码');
            return;
        }
        
        try {
            phoneLoginBtn.disabled = true;
            phoneLoginBtn.textContent = '登录中...';
            
            const response = await fetch(`/api/login/phone?phone=${encodeURIComponent(phoneNumber)}&auth_code=${encodeURIComponent(authCode)}`, {
                method: 'POST'
            });
            
            const data = await response.json();
            if (data.status === 'success') {
                uiAlert(data.message);
                window.location.reload();
            } else {
                uiAlert(data.message);
                phoneLoginBtn.disabled = false;
                phoneLoginBtn.textContent = '登录';
            }
        } catch (error) {
            console.error('手机号登录失败:', error);
            uiAlert('登录失败，请稍后重试');
            phoneLoginBtn.disabled = false;
            phoneLoginBtn.textContent = '登录';
        }
    }

    async function checkInitialAuth() {
        try {
            const response = await fetch('/api/check-auth');
            const data = await response.json();
            if (data.is_logged_in) {
                loginStatus.textContent = '已恢复登录';
                loginBtn.style.display = 'none';
                logoutBtn.style.display = 'inline-block';
                loadUserInfo();
                await getUserPlaylists();
            } else {
                loginStatus.textContent = '未登录';
                loginBtn.style.display = 'inline-block';
                logoutBtn.style.display = 'none';
            }
        } catch (error) {
            console.error('检查初始登录状态失败:', error);
        }
    }

    async function loadUserInfo() {
        try {
            const response = await fetch('/api/user/info');
            const data = await response.json();
            if (data && data.nick_name) {
                const avatar = document.getElementById('user-avatar');
                const nickname = document.getElementById('user-nickname');
                if (data.head_url) {
                    // 走本站代理，避免浏览器直连 QQ CDN 被混合内容/防盗链拦截
                    avatar.src = '/api/avatar';
                    avatar.onerror = () => { avatar.style.display = 'none'; };
                    avatar.style.display = 'inline-block';
                }
                nickname.textContent = data.nick_name;
                nickname.style.display = 'inline-block';
            }
        } catch (error) {
            console.error('获取用户信息失败:', error);
        }
    }

    function clearUserInfo() {
        const avatar = document.getElementById('user-avatar');
        const nickname = document.getElementById('user-nickname');
        avatar.style.display = 'none';
        avatar.src = '';
        nickname.style.display = 'none';
        nickname.textContent = '';
    }

    let allPlaylists = [];      // 服务端返回的完整歌单列表（过滤时从这里取）
    let monitoredIds = [];      // 正在监控的歌单 id（用于渲染监控按钮状态）

    function isMonitoredPlaylist(id) {
        return monitoredIds.includes(String(id));
    }

    async function getUserPlaylists() {
        try {
            const response = await fetch('/api/playlists');
            const playlists = await response.json();
            if (playlists.error) {
                playlistsContainer.innerHTML = `<p class="text-danger">获取歌单失败: ${playlists.error}</p>`;
                return;
            }
            allPlaylists = Array.isArray(playlists) ? playlists : [];
            renderPlaylists();
        } catch (error) {
            console.error('获取歌单失败:', error);
            playlistsContainer.innerHTML = '<p class="text-danger">获取歌单时发生错误。</p>';
        }
    }

    function renderPlaylists() {
        if (!allPlaylists.length) {
            playlistsContainer.innerHTML = `
                <div class="empty-state">
                    <i class="bi bi-collection"></i>
                    <div>你还没有创建或收藏任何歌单</div>
                </div>`;
            return;
        }

        const matched = allPlaylists;

        const renderPlaylist = (pl) => {
            // 记下歌单名，单曲下载时作为默认目录命名的提示传给后端
            playlistTitles[String(pl.dissid)] = pl.title || '';
            const isFav = pl.type === 'favorite';
            const cover = coverUrlFromPicUrl(pl.picurl);
            const isOn = isMonitoredPlaylist(pl.dissid);
            return `
                <div class="list-group-item${isOn ? ' monitored' : ''}">
                    <a href="#" class="playlist-item flex-grow-1" data-id="${pl.dissid}">
                        <span class="pl-icon">
                            <i class="bi ${isFav ? 'bi-heart' : 'bi-music-note-list'}"></i>
                            ${cover ? `<img class="pl-cover" src="${cover}" alt="" loading="lazy" onerror="this.remove()">` : ''}
                        </span>
                        <span class="pl-name flex-grow-1" title="${pl.title}">${pl.title}</span>
                        <span class="badge">${pl.subtitle || ''}</span>
                    </a>
                    <button class="btn btn-sm monitor-btn${isOn ? ' active' : ''}" data-id="${pl.dissid}"
                            aria-pressed="${isOn ? 'true' : 'false'}"
                            title="${isOn ? '已开启监控：该歌单有新增歌曲会自动下载，点击取消' : '开启监控：该歌单有新增歌曲时自动下载'}">
                        ${monitorButtonHtml(isOn)}
                    </button>
                </div>
            `;
        };
        const createdPlaylists = matched.filter(p => p.type === 'created');
        const favoritePlaylists = matched.filter(p => p.type === 'favorite');
        let finalHtml = '';
        if (createdPlaylists.length > 0) {
            finalHtml += '<h6><i class="bi bi-music-note-list"></i> 自建歌单</h6>';
            finalHtml += `<div class="list-group mb-3">${createdPlaylists.map(renderPlaylist).join('')}</div>`;
        }
        if (favoritePlaylists.length > 0) {
            finalHtml += '<h6><i class="bi bi-heart-fill"></i> 收藏歌单</h6>';
            finalHtml += `<div class="list-group">${favoritePlaylists.map(renderPlaylist).join('')}</div>`;
        }
        playlistsContainer.innerHTML = finalHtml;
        setupPlaylistListeners();
        updateMonitorButtons();
    }

    let _playlistDelegationBound = false;

    function setupPlaylistListeners() {
        // 使用事件委托，容器内任何 monitor-btn / playlist-item 都能响应，
        // 避免歌单重新渲染后按钮事件丢失（导致点击监听后需刷新才能取消）。
        // 委托只在首次绑定，防止多次渲染时重复累加监听器。
        if (_playlistDelegationBound) return;
        _playlistDelegationBound = true;
        playlistsContainer.addEventListener('click', (e) => {
            const monitorBtn = e.target.closest('.monitor-btn');
            const playlistItem = e.target.closest('.playlist-item');
            if (monitorBtn) {
                e.preventDefault();
                handleMonitorClick(monitorBtn);
            } else if (playlistItem) {
                e.preventDefault();
                document.querySelectorAll('.list-group-item').forEach(i => i.classList.remove('active'));
                playlistItem.closest('.list-group-item').classList.add('active');
                getSongsInPlaylist(playlistItem.dataset.id);
            }
        });
    }

    // 监控按钮内容：状态一眼可辨（图标 + 文案 + 监控中的呼吸点）
    function monitorButtonHtml(isMonitored, busy = false) {
        if (busy) {
            return '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
        }
        const icon = isMonitored ? 'bi-broadcast' : 'bi-eye';
        const text = isMonitored ? '监控中' : '监控';
        const dot = isMonitored ? '<span class="monitor-dot"></span>' : '';
        return `<i class="bi ${icon}"></i><span class="monitor-text">${text}</span>${dot}`;
    }

    async function handleMonitorClick(button) {
        const playlistId = button.dataset.id;
        const wasMonitored = button.classList.contains('active');
        button.disabled = true;
        button.innerHTML = monitorButtonHtml(wasMonitored, true);
        try {
            const response = await fetch(`/api/monitor/${playlistId}`, { method: 'POST' });
            const data = await response.json();
            if (data.status === 'success') {
                await updateMonitorButtons();
            } else {
                uiAlert(`操作失败: ${data.message}`);
                await updateMonitorButtons();   // 回到真实状态
            }
        } catch (error) {
            console.error('监控操作失败:', error);
            await updateMonitorButtons();
        } finally {
            button.disabled = false;
        }
    }

    async function updateMonitorButtons() {
        try {
            const response = await fetch('/api/monitor/status');
            monitoredIds = (await response.json()).map(String);
            document.querySelectorAll('.monitor-btn').forEach(button => {
                const playlistId = String(button.dataset.id);
                const isMonitored = isMonitoredPlaylist(playlistId);
                button.classList.toggle('active', isMonitored);
                button.setAttribute('aria-pressed', isMonitored ? 'true' : 'false');
                button.title = isMonitored
                    ? '已开启监控：该歌单有新增歌曲会自动下载，点击取消'
                    : '开启监控：该歌单有新增歌曲时自动下载';
                button.innerHTML = monitorButtonHtml(isMonitored);
                const row = button.closest('.list-group-item');
                if (row) row.classList.toggle('monitored', isMonitored);
            });
        } catch (error) {
            console.error('更新监控状态失败:', error);
        }
    }

    // --- Song List & Download Logic (remains mostly the same) ---
    let allSongs = [];
    let loadedSongsCount = 0;
    const songsPerLoad = 30;

    // 歌曲列表事件委托：在容器上绑一次，任何渲染时机都能响应播放/下载按钮，
    // 避免轮询重渲染导致逐行绑定的事件丢失（点击无响应）。
    function bindSongListDelegation() {
        songListContainer.addEventListener('click', async (e) => {
            const playBtn = e.target.closest('.play-btn');
            if (playBtn) {
                e.preventDefault();
                const item = playBtn.closest('.song-item');
                if (item) {
                    playSong(item.dataset.songMid, item.dataset.songName || '');
                }
                return;
            }
            const dlBtn = e.target.closest('.download-btn');
            if (dlBtn) {
                e.preventDefault();
                const item = dlBtn.closest('.song-item');
                if (!item) return;
                const mid = item.dataset.songMid;
                // 注意：用 data-song-name 取歌名（列表结构里第一个 <span> 是序号）
                const name = item.dataset.songName || '';
                // 已下载/失败/已取消：先复查本地文件，再确认是否重新下载
                if (dlBtn.dataset.reDownload) {
                    recheckAndRedownload(dlBtn, mid, name);
                    return;
                }
                // 已有本地文件（无任务记录）：弹窗确认是否重新下载（重新下载才会覆盖）
                if (dlBtn.dataset.hasLocalFile) {
                    const ok = await uiConfirm({
                        title: '本地已有该文件',
                        message: '重新下载会覆盖本地这份文件。',
                        rows: [{ label: '歌曲', value: name }],
                        confirmText: '重新下载',
                        tone: 'warning',
                    });
                    if (!ok) return;
                    delete dlBtn.dataset.hasLocalFile;
                    dlBtn.textContent = '队列中';
                    dlBtn.disabled = true;
                    startDownload(mid, name, true);
                    return;
                }
                dlBtn.textContent = '队列中';
                dlBtn.disabled = true;
                startDownload(mid, name).then(data => {
                    if (data && data.status === 'local_exists') {
                        const info = data.local_info || {};
                        uiAlert({
                            title: '本地已存在，已跳过',
                            message: '目标目录中已有这个文件，未重复下载。如需覆盖，请点「重新下载」。',
                            rows: [
                                info.quality ? { label: '音质', value: info.quality } : null,
                                info.size ? { label: '大小', value: formatFileSize(info.size) } : null,
                                info.filename ? { label: '文件', value: info.filename, title: info.path || '' } : null,
                            ].filter(Boolean),
                            tone: 'success',
                        });
                    }
                });
            }
        });
    }

    bindSongListDelegation();

    async function searchSongs(keyword) {
        if (!keyword) {
            return;
        }
        // 搜索结果不属于任何歌单：下载走默认目录
        currentPlaylistId = null;
        currentPlaylistName = '';
        songListContainer.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div></div>';
        allSongs = [];
        loadedSongsCount = 0;
        songListContainer.onscroll = null;
        try {
            const response = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
            const songs = await response.json();
            if (songs.error) {
                songListContainer.innerHTML = `<p class="text-danger">搜索失败: ${songs.error}</p>`;
                return;
            }
            if (!Array.isArray(songs) || songs.length === 0) {
                songListContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="bi bi-search"></i>
                        <div>没有找到相关歌曲</div>
                    </div>`;
                return;
            }
            allSongs = songs;
            songListContainer.innerHTML = `
                <div class="song-toolbar">
                    <div class="toolbar-title">
                        <i class="bi bi-search"></i>
                        <span class="text-truncate" title="${keyword}">搜索结果：${keyword}</span>
                        <span class="toolbar-count">${songs.length} 首</span>
                    </div>
                    <button class="btn btn-outline-secondary btn-sm" id="search-clear-btn">清除</button>
                </div>
                <ul class="list-group list-group-flush"></ul>
            `;
            loadMoreSongs();
            document.getElementById('search-clear-btn').addEventListener('click', () => {
                document.getElementById('song-search-input').value = '';
                songListContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="bi bi-music-note-list"></i>
                        <div>请从左侧选择一个歌单</div>
                    </div>`;
                allSongs = [];
                loadedSongsCount = 0;
                songListContainer.onscroll = null;
                currentPlaylistId = null;
                currentPlaylistName = '';
            });
            songListContainer.onscroll = () => {
                if (songListContainer.scrollTop + songListContainer.clientHeight >= songListContainer.scrollHeight - 200) {
                    loadMoreSongs();
                }
            };
        } catch (error) {
            console.error('搜索歌曲失败:', error);
            songListContainer.innerHTML = '<p class="text-danger">搜索歌曲时发生错误。</p>';
        }
    }

    async function getSongsInPlaylist(playlistId) {
        // 记录当前歌单：这一页里的单曲下载都保存到该歌单的目录
        currentPlaylistId = String(playlistId);
        currentPlaylistName = playlistTitles[currentPlaylistId] || '';
        songListContainer.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div></div>';
        allSongs = [];
        loadedSongsCount = 0;
        songListContainer.onscroll = null;
        try {
            const response = await fetch(`/api/playlist/${playlistId}`);
            const songs = await response.json();
            if (songs.error) {
                songListContainer.innerHTML = `<p class="text-danger">获取歌曲失败: ${songs.error}</p>`;
                return;
            }
            if (songs.length === 0) {
                songListContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="bi bi-inbox"></i>
                        <div>这个歌单里没有歌曲</div>
                    </div>`;
                return;
            }
            allSongs = songs;
            songListContainer.innerHTML = `
                <div class="song-toolbar">
                    <div class="toolbar-title">
                        <i class="bi bi-music-note-list"></i>
                        <span class="text-truncate" title="${currentPlaylistName || ''}">${currentPlaylistName || '歌单'}</span>
                        <span class="toolbar-count">${allSongs.length} 首</span>
                    </div>
                    <button class="btn btn-success btn-sm" id="download-all-btn" data-playlist-id="${playlistId}">
                        <i class="bi bi-download"></i> 全部下载
                    </button>
                </div>
                <ul class="list-group list-group-flush"></ul>
            `;
            loadMoreSongs();
            const downloadAllBtn = document.getElementById('download-all-btn');
            const downloadAllLabel = downloadAllBtn.innerHTML;
            downloadAllBtn.addEventListener('click', async (e) => {
                const button = e.currentTarget;
                button.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 正在加入队列';
                button.disabled = true;
                try {
                    const res = await fetch(`/api/playlist/download/${playlistId}`, { method: 'POST' });
                    const data = await res.json().catch(() => ({}));
                    uiAlert(data.message || '已将歌单中所有未下载的歌曲加入下载队列。');
                } catch (error) {
                    console.error('完整下载歌单失败:', error);
                    uiAlert('操作失败，请查看控制台。');
                } finally {
                    button.innerHTML = downloadAllLabel;
                    button.disabled = false;
                }
            });
            songListContainer.onscroll = () => {
                if (songListContainer.scrollTop + songListContainer.clientHeight >= songListContainer.scrollHeight - 200) {
                    loadMoreSongs();
                }
            };
        } catch (error) {
            console.error('获取歌曲列表失败:', error);
            songListContainer.innerHTML = '<p class="text-danger">获取歌曲列表时发生错误。</p>';
        }
    }

    function loadMoreSongs() {
        if (loadedSongsCount >= allSongs.length) return;
        const songListUl = songListContainer.querySelector('ul');
        const songsToLoad = allSongs.slice(loadedSongsCount, loadedSongsCount + songsPerLoad);
        const songsHtml = songsToLoad.map((song, i) => {
            const no = loadedSongsCount + i + 1;
            const singers = (song.singer || []).map(s => s.name).join(', ');
            const album = song.album && song.album.name ? song.album.name : '';
            const cover = albumCoverUrl(song.album && song.album.mid);
            const displayName = `${song.name} - ${singers}`;
            const duration = formatDuration(song.interval);

            // 本地状态：本地已存在 + 音质 + 大小，做成行内小药丸
            let localPills = '';
            if (song.local_info) {
                const info = song.local_info;
                localPills = `
                    <span class="pill pill-local" title="目标目录中已有此文件：${info.filename || ''}">
                        <i class="bi bi-check2-circle"></i>本地已存在
                    </span>
                    <span class="pill pill-quality">${info.quality || '未知音质'}</span>
                    <span class="pill pill-size">${formatFileSize(info.size)}</span>
                `;
            }

            return `
                <li class="list-group-item song-item" data-song-mid="${song.mid}" data-song-name="${displayName}">
                    <span class="song-index">${no}</span>
                    <span class="song-cover-wrap">
                        <i class="bi bi-music-note"></i>
                        ${cover ? `<img class="song-cover" src="${cover}" alt="" loading="lazy" onerror="this.remove()">` : ''}
                    </span>
                    <div class="song-title-wrap">
                        <div class="song-title" title="${song.name}">${song.name}</div>
                        <div class="song-sub">
                            <span class="song-singer">${singers}</span>
                            ${album ? `<span class="song-album" title="专辑：${album}">· ${album}</span>` : ''}
                            ${localPills}
                        </div>
                    </div>
                    <span class="song-duration">${duration}</span>
                    <div class="song-actions">
                        <button class="btn btn-icon play-btn" title="试听">
                            <i class="bi bi-play-fill"></i>
                        </button>
                        <button class="btn btn-primary download-btn">下载</button>
                    </div>
                </li>
            `;
        }).join('');
        songListUl.innerHTML += songsHtml;
        loadedSongsCount += songsToLoad.length;

        // 为新加载的按钮设置初始状态
        // 事件使用委托（见 _bindSongListDelegation），避免逐行绑定在轮询重渲染时丢失
        const newItems = Array.from(songListUl.children).slice(-songsToLoad.length);
        newItems.forEach((item, index) => {
            const button = item.querySelector('.download-btn');
            const songMid = item.dataset.songMid;
            const task = currentTasks[songMid];
            const song = songsToLoad[index];
            const localInfo = song.local_info;
            updateSongButtonState(button, task, localInfo);
        });
        syncPlayButtons();
    }

    // 专辑封面：统一取 150×150 那张（实测单张约 10.7KB，浏览器缓存 3 天）
    function albumCoverUrl(albumMid) {
        return albumMid
            ? `https://y.qq.com/music/photo_new/T002R150x150M000${albumMid}.jpg`
            : '';
    }

    // 歌单封面：接口给的 picurl 是 500×500（约 124KB），对 36px 缩略图太浪费，
    // 从里面取出专辑 mid 换成 150×150（约 15KB）；取不到就把 http 升级成 https
    function coverUrlFromPicUrl(picUrl) {
        if (!picUrl) return '';
        const matched = String(picUrl).match(/T002R\d+x\d+M000([A-Za-z0-9]+)\.jpg/);
        if (matched) return albumCoverUrl(matched[1]);
        return String(picUrl).replace(/^http:\/\//, 'https://');
    }

    function formatDuration(seconds) {
        const total = Number(seconds);
        if (!isFinite(total) || total <= 0) return '--:--';
        const m = Math.floor(total / 60);
        const s = Math.floor(total % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // --- 播放器逻辑 ---
    const audioPlayer = document.getElementById('audio-player');
    const playerBar = document.getElementById('player-bar');
    const playerSongName = document.getElementById('player-song-name');
    const playerTime = document.getElementById('player-time');
    const playerProgressBar = document.getElementById('player-progress-bar');
    const playerToggleBtn = document.getElementById('player-toggle-btn');
    const playerToggleIcon = document.getElementById('player-toggle-icon');
    let currentPlayback = { mid: null, name: '' };

    // 播放出错时把具体原因显示出来，便于排查（1=中止 2=网络 3=解码 4=源不支持）
    audioPlayer.addEventListener('error', () => {
        const mediaError = audioPlayer.error;
        if (mediaError) {
            console.error('音频播放错误, code =', mediaError.code, mediaError.message);
            setPlayerBuffering(false);
            playerBar.classList.add('player-error');
            if (playerArtist) playerArtist.textContent = '';
            playerSongName.textContent = `播放失败: 媒体错误 ${mediaError.code}`;
            if (playerState) playerState.textContent = '播放出错';
        }
    });

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // --- 播放条状态：缓冲 / 播放中 / 音量 ---
    const playerMuteBtn = document.getElementById('player-mute-btn');
    const playerVolume = document.getElementById('player-volume');
    const playerToggleSpinner = document.getElementById('player-toggle-spinner');
    const playerState = document.getElementById('player-state');
    const playerArtist = document.getElementById('player-artist');
    let lastNonZeroVolume = 0.8;

    function setPlayerBuffering(on) {
        playerBar.classList.toggle('buffering', Boolean(on));
        if (playerToggleSpinner) playerToggleSpinner.style.display = on ? 'inline-block' : 'none';
        playerToggleIcon.style.display = on ? 'none' : '';
        if (playerState) {
            playerState.textContent = on
                ? '正在缓冲…'
                : (playerBar.classList.contains('playing') ? '正在播放' : '已暂停');
        }
    }

    function setPlayerPlaying(on) {
        playerBar.classList.toggle('playing', Boolean(on));
        if (!playerBar.classList.contains('buffering') && playerState) {
            playerState.textContent = on ? '正在播放' : '已暂停';
        }
    }

    function applyVolume(value, persist = true) {
        const volume = Math.min(1, Math.max(0, Number(value) || 0));
        audioPlayer.volume = volume;
        if (volume > 0) lastNonZeroVolume = volume;
        if (playerVolume) playerVolume.value = String(Math.round(volume * 100));
        const icon = playerMuteBtn && playerMuteBtn.querySelector('i');
        if (icon) {
            icon.className = volume === 0 ? 'bi bi-volume-mute'
                : (volume < 0.5 ? 'bi bi-volume-down' : 'bi bi-volume-up');
        }
        if (persist) {
            try { localStorage.setItem('playerVolume', String(volume)); } catch (e) { /* 忽略隐私模式报错 */ }
        }
    }

    (function initPlayerVolume() {
        let saved = 1;
        try {
            const raw = localStorage.getItem('playerVolume');
            if (raw !== null && raw !== '' && isFinite(Number(raw))) saved = Number(raw);
        } catch (e) { /* 忽略 */ }
        applyVolume(saved, false);
        if (playerVolume) playerVolume.addEventListener('input', () => applyVolume(Number(playerVolume.value) / 100));
        if (playerMuteBtn) {
            playerMuteBtn.addEventListener('click', () => {
                applyVolume(audioPlayer.volume > 0 ? 0 : (lastNonZeroVolume || 0.8), audioPlayer.volume === 0);
            });
        }
    })();

    // 缓冲与播放状态：由 audio 元素事件驱动，按钮上显示转圈
    audioPlayer.addEventListener('waiting', () => setPlayerBuffering(true));
    audioPlayer.addEventListener('canplay', () => setPlayerBuffering(false));
    audioPlayer.addEventListener('stalled', () => setPlayerBuffering(true));

    async function playSong(songMid, songName) {
        if (currentPlayback.mid === songMid && !audioPlayer.paused && !audioPlayer.ended) {
            // 点击同一首歌且正在播放 → 暂停
            audioPlayer.pause();
            return;
        }
        try {
            // 标题行只放歌名，歌手挪到副行（原来挤成"歌名 - 歌手"一条太长）
            const rawName = String(songName || songMid);
            const nameParts = rawName.split(' - ');
            const trackTitle = nameParts.shift() || rawName;
            if (playerArtist) playerArtist.textContent = nameParts.join(' - ');
            playerSongName.textContent = trackTitle;
            playerBar.classList.remove('player-error');
            setPlayerBuffering(true);
            playerBar.style.display = 'block';
            document.body.classList.add('has-player');
            // 播放条封面（从当前列表里找这首歌的专辑 mid）
            const coverEl = document.getElementById('player-cover');
            if (coverEl) {
                const playingSong = allSongs.find(s => s.mid === songMid);
                const cover = playingSong ? albumCoverUrl(playingSong.album && playingSong.album.mid) : '';
                if (cover) {
                    coverEl.src = cover;
                    coverEl.style.display = 'block';
                } else {
                    coverEl.style.display = 'none';
                    coverEl.removeAttribute('src');
                }
            }
            const response = await fetch(`/api/play/${songMid}`);
            if (!response.ok) {
                const err = await response.json();
                setPlayerBuffering(false);
                playerBar.classList.add('player-error');
                if (playerArtist) playerArtist.textContent = '';
                playerSongName.textContent = `播放失败: ${err.detail || '无法获取链接'}`;
                if (playerState) playerState.textContent = '获取播放地址失败';
                return;
            }
            const data = await response.json();
            currentPlayback = { mid: songMid, name: songName || '' };
            audioPlayer.src = data.url;
            await audioPlayer.play();
            setPlayerBuffering(false);
            setPlayerPlaying(true);
            playerToggleIcon.className = 'bi bi-pause-fill';
            syncPlayButtons();
        } catch (error) {
            console.error('播放失败:', error);
            setPlayerBuffering(false);
            playerBar.classList.add('player-error');
            if (playerArtist) playerArtist.textContent = '';
            playerSongName.textContent = `播放失败: ${error.name || ''} ${error.message || ''}`.trim();
            if (playerState) playerState.textContent = '播放失败';
        }
    }

    playerToggleBtn.addEventListener('click', () => {
        if (audioPlayer.paused) {
            audioPlayer.play();
            playerToggleIcon.className = 'bi bi-pause-fill';
        } else {
            audioPlayer.pause();
            playerToggleIcon.className = 'bi bi-play-fill';
        }
    });

    function syncPlayButtons() {
        // 同步歌曲行播放按钮：正在播放的显示暂停图标，并高亮整行
        const playing = !audioPlayer.paused && !audioPlayer.ended && currentPlayback.mid;
        document.querySelectorAll('.play-btn').forEach(btn => {
            const item = btn.closest('.song-item');
            const isCurrent = item && item.dataset.songMid === currentPlayback.mid;
            if (playing && isCurrent) {
                btn.innerHTML = '<i class="bi bi-pause-fill"></i>';
                btn.classList.add('active');
                btn.title = '暂停';
            } else {
                btn.innerHTML = '<i class="bi bi-play-fill"></i>';
                btn.classList.remove('active');
                btn.title = '试听';
            }
            if (item) {
                item.classList.toggle('playing', Boolean(playing && isCurrent));
            }
        });
    }

    function updatePlayerFill(pct) {
        playerProgressBar.value = pct;
    }

    audioPlayer.addEventListener('timeupdate', () => {
        if (!audioPlayer.duration) return;
        const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        updatePlayerFill(pct);
        playerTime.textContent = `${formatTime(audioPlayer.currentTime)} / ${formatTime(audioPlayer.duration)}`;
        syncPlayButtons();
    });

    playerProgressBar.addEventListener('input', () => {
        if (!audioPlayer.duration) return;
        audioPlayer.currentTime = (playerProgressBar.value / 100) * audioPlayer.duration;
        updatePlayerFill(playerProgressBar.value);
    });

    audioPlayer.addEventListener('play', () => {
        playerToggleIcon.className = 'bi bi-pause-fill';
        setPlayerPlaying(true);
        syncPlayButtons();
    });
    audioPlayer.addEventListener('pause', () => {
        playerToggleIcon.className = 'bi bi-play-fill';
        setPlayerPlaying(false);
        syncPlayButtons();
    });
    audioPlayer.addEventListener('ended', () => {
        playerToggleIcon.className = 'bi bi-play-fill';
        setPlayerPlaying(false);
        updatePlayerFill(0);
        playerTime.textContent = '0:00 / 0:00';
        if (playerState) playerState.textContent = '播放结束';
        syncPlayButtons();
    });

    document.getElementById('player-close-btn').addEventListener('click', () => {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        playerBar.style.display = 'none';
        playerBar.classList.remove('playing', 'buffering', 'player-error');
        document.body.classList.remove('has-player');
        playerSongName.textContent = '未在播放';
        if (playerArtist) playerArtist.textContent = '';
        if (playerState) playerState.textContent = '就绪';
        currentPlayback = { mid: null, name: '' };
        updatePlayerFill(0);
        playerTime.textContent = '0:00 / 0:00';
        syncPlayButtons();
    });

    // --- 通用对话框：替代原生 alert/confirm（Promise 化，样式与应用一致） ---
    const uiDialogEl = document.getElementById('ui-dialog');
    const uiDialogIcon = document.getElementById('ui-dialog-icon');
    const uiDialogTitle = document.getElementById('ui-dialog-title');
    const uiDialogMessage = document.getElementById('ui-dialog-message');
    const uiDialogRows = document.getElementById('ui-dialog-rows');
    const uiDialogConfirm = document.getElementById('ui-dialog-confirm');
    const uiDialogCancel = document.getElementById('ui-dialog-cancel');
    const UI_TONES = {
        info: { icon: 'bi-info-circle', btn: 'btn-primary' },
        success: { icon: 'bi-check-circle', btn: 'btn-primary' },
        warning: { icon: 'bi-exclamation-triangle', btn: 'btn-warning' },
        danger: { icon: 'bi-exclamation-octagon', btn: 'btn-danger' },
    };
    let uiDialogResolve = null;
    let uiDialogLastFocus = null;

    function dialogIsOpen() {
        return Boolean(uiDialogEl) && uiDialogEl.style.display !== 'none';
    }

    function closeDialog(result) {
        if (!dialogIsOpen()) return;
        uiDialogEl.style.display = 'none';
        const resolve = uiDialogResolve;
        uiDialogResolve = null;
        if (uiDialogLastFocus && typeof uiDialogLastFocus.focus === 'function') {
            try { uiDialogLastFocus.focus(); } catch (e) { /* 忽略 */ }
        }
        if (resolve) resolve(result);
    }

    function openDialog(options) {
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const tone = UI_TONES[opts.tone] ? opts.tone : 'info';
        const hasCancel = opts.cancelText !== '';

        uiDialogIcon.className = `ui-dialog-icon tone-${tone}`;
        uiDialogIcon.innerHTML = `<i class="bi ${UI_TONES[tone].icon}"></i>`;
        uiDialogTitle.textContent = opts.title || (hasCancel ? '请确认' : '提示');
        uiDialogMessage.textContent = opts.message || '';
        uiDialogMessage.style.display = opts.message ? '' : 'none';

        const rows = opts.rows || [];
        if (rows.length) {
            uiDialogRows.innerHTML = rows.map(row =>
                `<dt>${row.label || ''}</dt><dd${row.title ? ` title="${row.title}"` : ''}>${row.value || ''}</dd>`
            ).join('');
            uiDialogRows.style.display = '';
        } else {
            uiDialogRows.innerHTML = '';
            uiDialogRows.style.display = 'none';
        }

        uiDialogCancel.style.display = hasCancel ? '' : 'none';
        uiDialogCancel.textContent = opts.cancelText || '取消';
        uiDialogConfirm.textContent = opts.confirmText || '确定';
        uiDialogConfirm.className = `btn ${UI_TONES[tone].btn}`;

        uiDialogLastFocus = document.activeElement;
        uiDialogEl.style.display = 'flex';
        setTimeout(() => { try { uiDialogConfirm.focus(); } catch (e) { /* 忽略 */ } }, 30);

        return new Promise((resolve) => { uiDialogResolve = resolve; });
    }

    // uiAlert('文本') / uiAlert({title, message, rows, tone})
    function uiAlert(options) {
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        return openDialog(Object.assign({}, opts, { cancelText: '' }));
    }

    // uiConfirm('文本') / uiConfirm({title, message, rows, tone, confirmText}) → Promise<boolean>
    function uiConfirm(options) {
        return openDialog(typeof options === 'string' ? { message: options } : (options || {}));
    }

    if (uiDialogEl) {
        uiDialogConfirm.addEventListener('click', () => closeDialog(true));
        uiDialogCancel.addEventListener('click', () => closeDialog(false));
        uiDialogEl.querySelectorAll('[data-dialog-cancel]').forEach(el => {
            el.addEventListener('click', () => closeDialog(false));
        });
        document.addEventListener('keydown', (e) => {
            if (!dialogIsOpen()) return;
            if (e.key === 'Escape') { e.preventDefault(); closeDialog(false); }
            else if (e.key === 'Enter') { e.preventDefault(); closeDialog(true); }
        });
    }

    // --- 主题：跟随系统 / 浅色 / 深色（记忆在 localStorage） ---
    // 切换动效优先用 View Transitions API 做"圆形揭示"：
    // 整屏（含渐变背景、图片、滚动条）一次性过渡，比逐元素 transition 自然得多。
    const THEME_KEY = 'qqmusicTheme';
    const THEME_MODES = ['auto', 'light', 'dark'];
    const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

    function resolveTheme(mode) {
        return mode === 'auto' ? (themeMedia.matches ? 'dark' : 'light') : mode;
    }

    function paintThemeButton(mode) {
        const btn = document.getElementById('theme-toggle');
        if (!btn) return;
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = mode === 'auto' ? 'bi bi-circle-half'
                : (mode === 'dark' ? 'bi bi-moon-stars' : 'bi bi-sun');
        }
        btn.title = `主题：${mode === 'auto' ? '跟随系统' : (mode === 'dark' ? '深色' : '浅色')}（点击切换）`;
    }

    function commitTheme(mode) {
        document.documentElement.setAttribute('data-bs-theme', resolveTheme(mode));
        document.documentElement.dataset.themeMode = mode;
        paintThemeButton(mode);
        try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 忽略隐私模式报错 */ }
    }

    /**
     * @param {string} mode    auto | light | dark
     * @param {boolean} fade   true 走整屏淡入淡出；false 直接切换（首屏用）
     */
    function applyTheme(mode, fade) {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const canAnimate = typeof document.startViewTransition === 'function' && !reduceMotion;

        if (!fade || !canAnimate) {
            commitTheme(mode);
            return;
        }

        // 用 View Transition 做整屏交叉淡化：渐变背景、图片、滚动条都会一起淡过去，
        // 不做任何方向性动画（避免"从某个角扫过来"的观感）。
        const root = document.documentElement;
        root.classList.add('theme-switching');

        const transition = document.startViewTransition(() => commitTheme(mode));
        transition.finished
            .catch(() => { /* 过渡被中断也无所谓 */ })
            .finally(() => root.classList.remove('theme-switching'));
    }

    function setupTheme() {
        let mode = 'auto';
        try {
            const saved = localStorage.getItem(THEME_KEY);
            if (saved && THEME_MODES.includes(saved)) mode = saved;
        } catch (e) { /* 忽略 */ }
        applyTheme(mode, false);                // 首屏不做动画

        const btn = document.getElementById('theme-toggle');
        if (btn) {
            btn.addEventListener('click', () => {
                const current = document.documentElement.dataset.themeMode || 'auto';
                applyTheme(THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length], true);
            });
        }
        // 跟随系统时，系统主题变化 → 整屏交叉淡化
        themeMedia.addEventListener('change', () => {
            if ((document.documentElement.dataset.themeMode || 'auto') === 'auto') applyTheme('auto', true);
        });
    }
    setupTheme();

    // --- 键盘快捷键：空格/K 播放暂停，←/→ 快退快进 5 秒 ---
    document.addEventListener('keydown', (e) => {
        if (dialogIsOpen()) return;              // 对话框打开时不响应播放快捷键
        const tag = (e.target.tagName || '').toLowerCase();
        if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === 'Space' || e.key.toLowerCase() === 'k') {
            if (!audioPlayer.src) return;
            e.preventDefault();
            if (audioPlayer.paused) audioPlayer.play(); else audioPlayer.pause();
        } else if (e.key === 'ArrowLeft' && audioPlayer.src) {
            e.preventDefault();
            audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 5);
        } else if (e.key === 'ArrowRight' && audioPlayer.src) {
            e.preventDefault();
            audioPlayer.currentTime = Math.min(audioPlayer.duration || 0, audioPlayer.currentTime + 5);
        }
    });

    async function startDownload(songMid, songName, force = false) {
        // 返回服务端响应，由调用方决定怎么提示（不再内部弹窗）
        try {
            const params = new URLSearchParams();
            params.set('song_name', songName);
            if (force) params.set('force', 'true');
            // 歌单页里下载：带上歌单标识，后端按该歌单的目标目录保存
            if (currentPlaylistId) {
                params.set('playlist_id', currentPlaylistId);
                if (currentPlaylistName) params.set('playlist_name', currentPlaylistName);
            }
            const response = await fetch(`/api/download/${songMid}?${params.toString()}`, { method: 'POST' });
            return await response.json().catch(() => ({}));
        } catch (error) {
            console.error('启动下载失败:', error);
            return {};
        }
    }

    // "已下载/失败/已取消"的歌曲：先让服务端复查本地文件是否还在，
    // 还在就弹确认框（含音质与大小），确认后才覆盖重下
    async function recheckAndRedownload(button, songMid, songName) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = '检查中...';

        const data = await startDownload(songMid, songName, false);

        if (data.status === 'local_exists') {
            button.disabled = false;
            button.textContent = originalText;
            const info = data.local_info || {};
            const ok = await uiConfirm({
                title: '本地文件仍然存在',
                message: '重新下载会覆盖本地这份文件。',
                rows: [
                    info.quality ? { label: '音质', value: info.quality } : null,
                    info.size ? { label: '大小', value: formatFileSize(info.size) } : null,
                    info.filename ? { label: '文件', value: info.filename, title: info.path || '' } : null,
                ].filter(Boolean),
                confirmText: '重新下载并覆盖',
                tone: 'warning',
            });
            if (!ok) return;
            button.disabled = true;
            button.textContent = '队列中';
            await startDownload(songMid, songName, true);
            return;
        }

        if (data.status === 'skipped') {
            button.disabled = false;
            button.textContent = originalText;
            uiAlert(data.message || '任务已在队列中。');
            return;
        }

        // 本地文件其实已经不在了 → 服务端已直接加入下载队列
        button.disabled = true;
        button.textContent = '队列中';
    }

    // --- MODIFIED Download Status Logic ---

    async function updateDownloadStatus() {
        const selectedOngoingMids = new Set(
            Array.from(document.querySelectorAll('.ongoing-task-checkbox:checked')).map(cb => cb.value)
        );
        const selectedCompletedMids = new Set(
            Array.from(document.querySelectorAll('.completed-task-checkbox:checked')).map(cb => cb.value)
        );

        try {
            const response = await fetch('/api/download/status');
            const data = await response.json();
            currentTasks = data.tasks || {}; // 更新全局任务状态
            const tasks = currentTasks;
            const ongoingTasks = [];
            const completedTasks = [];

            updateApiCooldownTimer(data.api_cooldown_until, data.server_time);

            for (const mid in tasks) {
                const taskWithMid = { ...tasks[mid], mid };
                if (tasks[mid].status === 'completed' || tasks[mid].status === 'local_exists') {
                    completedTasks.push(taskWithMid);
                } else {
                    ongoingTasks.push(taskWithMid);
                }
            }

            // Sort ongoing tasks: downloading > queued > others, then by original order (newest first)
            const statusPriority = { 'downloading': 1, 'queued': 2 };
            ongoingTasks.sort((a, b) => {
                const priorityA = statusPriority[a.status] || 3;
                const priorityB = statusPriority[b.status] || 3;
                if (priorityA !== priorityB) {
                    return priorityA - priorityB;
                }
                // If priorities are the same, newest (later in original array) comes first
                // We need original indices, but since we don't have them, we can assume
                // the server sends them in a somewhat consistent order. Reversing the original
                // list before processing is a good proxy for "newest first".
                // Let's stick to reversing the completed list for now as that's less critical.
                return 0; // Keep original relative order for same-status tasks for now
            });

            completedTasks.reverse();

            // Update counts
            document.getElementById('ongoing-count').textContent = ongoingTasks.length;
            document.getElementById('completed-count').textContent = completedTasks.length;

            // Update ongoing list UI
            if (ongoingTasks.length === 0) {
                ongoingDownloadsList.innerHTML = '<li class="list-group-item">暂无进行中的任务</li>';
                selectAllOngoingContainer.style.display = 'none';
                ongoingActions.style.display = 'none';
            } else {
                ongoingDownloadsList.innerHTML = ongoingTasks.map(task => createTaskItemHtml(task)).join('');
                selectAllOngoingContainer.style.display = 'flex';
            }

            // Add "Retry All Failed" button if there are any failed tasks
            const failedTasksCount = ongoingTasks.filter(t => t.status === 'failed').length;
            const retryAllBtnContainer = document.getElementById('retry-all-container'); // Assuming a container exists
            if (retryAllBtnContainer) {
                if (failedTasksCount > 0) {
                    retryAllBtnContainer.innerHTML = `
                        <button class="btn btn-warning btn-sm" id="retry-all-failed-btn">
                            <i class="bi bi-arrow-clockwise"></i> 重试所有失败 (${failedTasksCount})
                        </button>`;
                    document.getElementById('retry-all-failed-btn').addEventListener('click', retryAllFailed);
                } else {
                    retryAllBtnContainer.innerHTML = '';
                }
            }

            // Update completed list UI (只渲染最近 N 条，历史仍保留在数据中)
            if (completedTasks.length === 0) {
                completedDownloadsList.innerHTML = '<li class="list-group-item">暂无已完成的任务</li>';
                selectAllCompletedContainer.style.display = 'none';
                completedActions.style.display = 'none';
            } else {
                const renderCompleted = completedTasks.slice(0, MAX_COMPLETED_RENDER);
                const totalCompleted = completedTasks.length;
                let html = renderCompleted.map(task => createTaskItemHtml(task)).join('');
                if (totalCompleted > MAX_COMPLETED_RENDER) {
                    html += `<li class="list-group-item text-muted small text-center">仅显示最近 ${MAX_COMPLETED_RENDER} 条，共 ${totalCompleted} 条历史记录</li>`;
                }
                completedDownloadsList.innerHTML = html;
                selectAllCompletedContainer.style.display = 'flex';
            }

            // Restore selection states
            selectedOngoingMids.forEach(mid => {
                const checkbox = document.querySelector(`.ongoing-task-checkbox[value="${mid}"]`);
                if (checkbox) checkbox.checked = true;
            });
            selectedCompletedMids.forEach(mid => {
                const checkbox = document.querySelector(`.completed-task-checkbox[value="${mid}"]`);
                if (checkbox) checkbox.checked = true;
            });
            
            updateSelectionState();

            // --- NEW: Update song list buttons based on task status ---
            document.querySelectorAll('.song-item').forEach(item => {
                const mid = item.dataset.songMid;
                const button = item.querySelector('.download-btn');
                if (button) {
                    // 查找对应的歌曲信息，获取local_info
                    const song = allSongs.find(s => s.mid === mid);
                    const localInfo = song ? song.local_info : null;
                    updateSongButtonState(button, tasks[mid], localInfo);
                }
            });

        } catch (error) {
            console.error("Error updating download status:", error);
        }
    }

    function formatFileSize(bytes) {
        /* 格式化文件大小为可读格式 */
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function updateSongButtonState(button, task, localInfo = null) {
        if (!button) return;

        // 每次刷新先清掉"复查后重下"标记，只有下面几个终态会重新打上
        delete button.dataset.reDownload;

        // "本地已存在"是下载前的跳过状态，不算进行中的任务：
        // 统一按"有本地文件"处理，按钮变成可点击的重新下载
        if (task && task.status === 'local_exists') {
            task = null;
        }

        if (task) {
            switch (task.status) {
                case 'completed':
                    // 可点击：会先复查本地文件是否还在，再确认是否覆盖重下
                    button.textContent = '已下载';
                    button.disabled = false;
                    button.dataset.reDownload = '1';
                    button.title = '点击可复查本地文件并重新下载';
                    button.className = 'btn btn-success btn-sm download-btn';
                    break;
                case 'downloading':
                    button.textContent = `下载中 (${task.progress || 0}%)`;
                    button.disabled = true;
                    button.className = 'btn btn-secondary btn-sm download-btn';
                    break;
                case 'queued':
                    button.textContent = '队列中';
                    button.disabled = true;
                    button.className = 'btn btn-secondary btn-sm download-btn';
                    break;
                case 'failed':
                    // 失败也允许点一下重新下载（不必去下载管理页重试）
                    button.textContent = '失败';
                    button.disabled = false;
                    button.dataset.reDownload = '1';
                    button.title = '点击可重新下载';
                    button.className = 'btn btn-danger btn-sm download-btn';
                    break;
                case 'cancelled':
                    button.textContent = '已取消';
                    button.disabled = false;
                    button.dataset.reDownload = '1';
                    button.title = '点击可重新下载';
                    button.className = 'btn btn-outline-danger btn-sm download-btn';
                    break;
                case 'waiting_for_retry':
                    button.textContent = '等待中';
                    button.disabled = true;
                    button.className = 'btn btn-warning btn-sm download-btn text-dark';
                    break;
                default:
                    button.textContent = '下载';
                    button.disabled = false;
                    button.className = 'btn btn-primary btn-sm download-btn';
            }
        } else if (localInfo) {
            // 目标目录里已有这首歌：提示本地已存在，可点击重新下载覆盖
            button.textContent = '重新下载';
            button.disabled = false;
            button.dataset.hasLocalFile = '1';
            button.className = 'btn btn-info btn-sm download-btn btn-local-file';
        } else {
            // If no task exists for this song, ensure button is in default state
            button.textContent = '下载';
            button.disabled = false;
            delete button.dataset.hasLocalFile;
            button.className = 'btn btn-primary btn-sm download-btn';
        }
    }

    function formatCountdown(seconds) {
        if (seconds <= 0) return "00:00:00";
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    function updateApiCooldownTimer(cooldownUntil, serverTime) {
        const timerSpan = document.getElementById('api-cooldown-timer');
        if (apiCooldownInterval) {
            clearInterval(apiCooldownInterval);
        }

        let remainingSeconds = Math.max(0, cooldownUntil - serverTime);

        if (remainingSeconds > 0) {
            timerSpan.style.display = 'inline-block';
            timerSpan.textContent = `账号限制中: ${formatCountdown(remainingSeconds)}`;

            apiCooldownInterval = setInterval(() => {
                remainingSeconds--;
                if (remainingSeconds <= 0) {
                    timerSpan.style.display = 'none';
                    clearInterval(apiCooldownInterval);
                    // Optionally, trigger a status update as the cooldown has just ended
                    updateDownloadStatus();
                } else {
                    timerSpan.textContent = `账号限制中: ${formatCountdown(remainingSeconds)}`;
                }
            }, 1000);
        } else {
            timerSpan.style.display = 'none';
        }
    }
    
    function createTaskItemHtml(task) {
        let statusContent = '';
        let actionButtons = '';
        let errorReason = '';
        let progressHtml = '';
        const isCompleted = task.status === 'completed' || task.status === 'local_exists';
        const checkboxClass = isCompleted ? 'completed-task-checkbox' : 'ongoing-task-checkbox';

        const checkboxHtml = `
            <div class="form-check m-0 pt-1">
                <input class="form-check-input ${checkboxClass}" type="checkbox" value="${task.mid}" id="task-${task.mid}">
            </div>`;

        switch (task.status) {
            case 'downloading':
                statusContent = `<span class="badge bg-primary">下载中</span>`;
                progressHtml = `<div class="progress mt-2"><div class="progress-bar" role="progressbar" style="width: ${task.progress || 0}%;">${task.progress || 0}%</div></div>`;
                actionButtons = `<button class="btn btn-outline-warning cancel-btn" data-mid="${task.mid}" title="取消"><i class="bi bi-x-lg"></i></button>`;
                break;
            case 'completed':
                statusContent = `<span class="badge bg-success">已完成</span>`;
                break;
            case 'local_exists': {
                // 下载前发现目标目录里已有同一首歌，直接跳过
                statusContent = `<span class="badge bg-info text-dark">本地已存在</span>`;
                const sizeText = task.file_size ? ` · ${formatFileSize(task.file_size)}` : '';
                const pathText = task.file_path ? `<div class="task-reason">${task.file_path}</div>` : '';
                errorReason = `<div class="task-reason mt-1">已跳过下载${sizeText}（如需覆盖请到歌曲列表点“重新下载”）</div>${pathText}`;
                actionButtons = `<button class="btn btn-outline-danger remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
                break;
            }
            case 'failed':
                statusContent = `<span class="badge bg-danger">下载失败</span>`;
                errorReason = `<div class="task-reason mt-1 text-danger">${task.error || '未知错误'}</div>`;
                actionButtons = `<button class="btn btn-outline-info retry-btn" data-mid="${task.mid}" title="重试"><i class="bi bi-arrow-clockwise"></i></button><button class="btn btn-outline-danger remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
                break;
            case 'waiting_for_retry':
                statusContent = `<span class="badge bg-warning text-dark">等待重试</span>`;
                const retryAt = task.retry_at; // UNIX timestamp in seconds
                const now = Math.floor(Date.now() / 1000);
                const remainingSeconds = Math.max(0, retryAt - now);
                
                const hours = Math.floor(remainingSeconds / 3600);
                const minutes = Math.floor((remainingSeconds % 3600) / 60);
                const seconds = remainingSeconds % 60;

                const countdownText = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                
                errorReason = `<div class="task-reason mt-1 pill pill-pending">账号超出下载限制，${countdownText} 后自动重试</div>`;
                actionButtons = `<button class="btn btn-outline-danger remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
                break;
            case 'queued':
                 statusContent = `<span class="badge bg-secondary">队列中</span>`;
                 actionButtons = `<button class="btn btn-outline-warning cancel-btn" data-mid="${task.mid}" title="取消"><i class="bi bi-x-lg"></i></button>`;
                 break;
            case 'cancelled':
                statusContent = `<span class="badge bg-dark">已取消</span>`;
                actionButtons = `<button class="btn btn-outline-danger remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
                break;
            default:
                statusContent = `<span class="badge bg-dark">${task.status}</span>`;
        }
        const qualityBadge = task.quality ? `<span class="pill pill-quality">${task.quality}</span>` : '';
        return `
            <li class="list-group-item">
                <div class="d-flex align-items-start gap-2">
                    ${checkboxHtml}
                    <div class="flex-grow-1" style="min-width: 0;">
                        <div class="d-flex align-items-center justify-content-between gap-2">
                            <label class="form-check-label task-name text-truncate mb-0" for="task-${task.mid}" title="${task.song_name}" style="cursor: pointer;">
                                ${task.song_name}
                            </label>
                            <div class="d-flex align-items-center gap-1 flex-shrink-0">
                                ${qualityBadge}
                                ${statusContent}
                            </div>
                        </div>
                        ${progressHtml}
                        ${errorReason}
                    </div>
                    <div class="task-actions d-flex align-items-center gap-1 flex-shrink-0">
                        ${actionButtons}
                    </div>
                </div>
            </li>`;
    }

    // --- Selection & Action Logic ---
    function updateSelectionState() {
        // Handle ongoing tasks selection
        const ongoingCheckboxes = document.querySelectorAll('.ongoing-task-checkbox');
        const checkedOngoing = document.querySelectorAll('.ongoing-task-checkbox:checked');
        ongoingActions.style.display = checkedOngoing.length > 0 ? 'block' : 'none';
        
        if (ongoingCheckboxes.length > 0 && checkedOngoing.length === ongoingCheckboxes.length) {
            selectAllOngoingCheckbox.checked = true;
            selectAllOngoingCheckbox.indeterminate = false;
        } else if (checkedOngoing.length > 0) {
            selectAllOngoingCheckbox.checked = false;
            selectAllOngoingCheckbox.indeterminate = true;
        } else {
            selectAllOngoingCheckbox.checked = false;
            selectAllOngoingCheckbox.indeterminate = false;
        }

        // Handle completed tasks selection
        const completedCheckboxes = document.querySelectorAll('.completed-task-checkbox');
        const checkedCompleted = document.querySelectorAll('.completed-task-checkbox:checked');
        completedActions.style.display = checkedCompleted.length > 0 ? 'block' : 'none';

        if (completedCheckboxes.length > 0 && checkedCompleted.length === completedCheckboxes.length) {
            selectAllCompletedCheckbox.checked = true;
            selectAllCompletedCheckbox.indeterminate = false;
        } else if (checkedCompleted.length > 0) {
            selectAllCompletedCheckbox.checked = false;
            selectAllCompletedCheckbox.indeterminate = true;
        } else {
            selectAllCompletedCheckbox.checked = false;
            selectAllCompletedCheckbox.indeterminate = false;
        }
    }

    selectAllOngoingCheckbox.addEventListener('change', (e) => {
        document.querySelectorAll('.ongoing-task-checkbox').forEach(checkbox => {
            checkbox.checked = e.target.checked;
        });
        updateSelectionState();
    });

    selectAllCompletedCheckbox.addEventListener('change', (e) => {
        document.querySelectorAll('.completed-task-checkbox').forEach(checkbox => {
            checkbox.checked = e.target.checked;
        });
        updateSelectionState();
    });

    async function retryAllFailed() {
        const btn = document.getElementById('retry-all-failed-btn');
        if (!btn) return;
        
        btn.textContent = '正在重试...';
        btn.disabled = true;
        try {
            const response = await fetch('/api/downloads/retry_all_failed', { method: 'POST' });
            const data = await response.json();
            uiAlert(data.message || '操作完成');
            updateDownloadStatus();
        } catch (error) {
            console.error('全部重试失败:', error);
            uiAlert('操作失败，请查看控制台。');
        } finally {
            // The button will be rebuilt by updateDownloadStatus, so no need to re-enable it here.
        }
    }

    document.body.addEventListener('click', async (e) => {
        const target = e.target;

        // If a checkbox is clicked, just update the state
        if (target.matches('.ongoing-task-checkbox, .completed-task-checkbox')) {
            updateSelectionState();
            return;
        }

        const actionTarget = target.closest('.retry-btn, .cancel-btn, .remove-btn, .bulk-action-btn, .bulk-action-btn-ongoing');
        if (!actionTarget) return;

        // Handle ongoing bulk actions
        if (actionTarget.matches('.bulk-action-btn-ongoing')) {
            e.preventDefault();
            const selectedMids = Array.from(document.querySelectorAll('.ongoing-task-checkbox:checked')).map(cb => cb.value);
            if (selectedMids.length === 0) {
                uiAlert('请至少选择一个进行中的任务。');
                return;
            }
            const action = actionTarget.dataset.action; // 'cancel' or 'remove'
            const confirmMessage = `确定要对选中的 ${selectedMids.length} 个任务执行 "${action === 'cancel' ? '取消' : '移除'}" 操作吗？`;
            
            const ok = await uiConfirm({ title: '批量操作', message: confirmMessage });
            if (ok) {
                for (const mid of selectedMids) {
                    try {
                        await fetch(`/api/download/${action}/${mid}`, { method: 'POST' });
                    } catch (error) {
                        console.error(`批量操作失败 for mid ${mid}:`, error);
                    }
                }
                updateDownloadStatus();
            }
            return;
        }

        // Handle completed bulk actions
        if (actionTarget.matches('.bulk-action-btn')) {
            e.preventDefault();
            const selectedMids = Array.from(document.querySelectorAll('.completed-task-checkbox:checked')).map(cb => cb.value);
            if (selectedMids.length === 0) {
                uiAlert('请至少选择一个任务。');
                return;
            }
            const deleteFiles = actionTarget.dataset.deleteFiles === 'true';
            let confirmMessage = `确定要从列表中移除选中的 ${selectedMids.length} 个任务吗？`;
            let confirmTone = 'warning';
            if (deleteFiles) {
                confirmMessage = `这会同时从磁盘永久删除这 ${selectedMids.length} 个文件，且不可恢复。`;
                confirmTone = 'danger';
            }
            const ok = await uiConfirm({
                title: deleteFiles ? '删除文件并移除任务' : '移除任务',
                message: confirmMessage,
                confirmText: deleteFiles ? '永久删除' : '移除',
                tone: confirmTone,
            });
            if (ok) {
                try {
                    await fetch('/api/downloads/remove_selected', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mids: selectedMids, delete_files: deleteFiles })
                    });
                    updateDownloadStatus();
                } catch (error) {
                    console.error('批量操作失败:', error);
                }
            }
            return;
        }
        actionTarget.disabled = true;
        const mid = actionTarget.dataset.mid;
        let actionUrl = '';
        if (actionTarget.matches('.retry-btn')) actionUrl = `/api/download/retry/${mid}`;
        if (actionTarget.matches('.cancel-btn')) actionUrl = `/api/download/cancel/${mid}`;
        if (actionTarget.matches('.remove-btn')) actionUrl = `/api/download/remove/${mid}`;
        
        if(actionUrl) {
            try {
                await fetch(actionUrl, { method: 'POST' });
                updateDownloadStatus();
            } catch (error) {
                console.error('操作失败:', error);
            }
        }
        setTimeout(() => {
            if (actionTarget) actionTarget.disabled = false;
        }, 500);
    });

    // --- 配置页面功能 ---
    
    function setupConfigPage() {
        // 导航切换
        document.getElementById('nav-music').addEventListener('click', (e) => {
            e.preventDefault();
            switchToPage('music');
        });
        
        document.getElementById('nav-config').addEventListener('click', (e) => {
            e.preventDefault();
            switchToPage('config');
        });

        document.getElementById('nav-logs').addEventListener('click', (e) => {
            e.preventDefault();
            switchToPage('logs');
        });
        
        // 加载配置
        loadConfig();
        
        // 表单提交
        document.getElementById('config-form').addEventListener('submit', handleConfigSubmit);
        
        // 重置按钮：恢复默认配置
        document.getElementById('reset-config-btn').addEventListener('click', async () => {
            const resetOk = await uiConfirm({
                title: '重置配置',
                message: '所有配置将恢复为默认值，包括下载目录、并发数与通知设置。',
                confirmText: '重置',
                tone: 'warning',
            });
            if (!resetOk) return;
            try {
                const response = await fetch('/api/config/reset', { method: 'POST' });
                const data = await response.json();
                if (data.config) {
                    fillFormWithConfig(data.config);
                    uiAlert('配置已重置为默认值。');
                } else {
                    uiAlert('重置失败，请查看控制台。');
                }
            } catch (error) {
                console.error('重置配置失败:', error);
                uiAlert('重置配置失败。');
            }
        });
        
        // 复选框事件
    document.getElementById('webhook-enabled').addEventListener('change', toggleWebhookFields);
    document.getElementById('bark-enabled').addEventListener('change', toggleBarkFields);
    document.getElementById('wecom-enabled').addEventListener('change', toggleWecomFields);
    document.getElementById('write-lyrics').addEventListener('change', toggleLyricFields);

    // 初始切换
    toggleWebhookFields();
    toggleBarkFields();
    toggleWecomFields();
    toggleLyricFields();

    setupLogsPage();
    }
    
    function switchToPage(pageName) {
        const musicContent = document.getElementById('music-content');
        const configContent = document.getElementById('config-content');
        const logsContent = document.getElementById('logs-content');
        const navMusic = document.getElementById('nav-music');
        const navConfig = document.getElementById('nav-config');
        const navLogs = document.getElementById('nav-logs');

        const setActive = (page) => {
            [navMusic, navConfig, navLogs].forEach(nav => nav && nav.classList.remove('active'));
            if (page === 'music' && navMusic) navMusic.classList.add('active');
            if (page === 'config' && navConfig) navConfig.classList.add('active');
            if (page === 'logs' && navLogs) navLogs.classList.add('active');
        };

        if (pageName === 'music') {
            if (musicContent) musicContent.style.display = 'flex';
            if (configContent) configContent.style.display = 'none';
            if (logsContent) logsContent.style.display = 'none';
            setActive('music');
            stopLogPolling();
        } else if (pageName === 'config') {
            if (musicContent) musicContent.style.display = 'none';
            if (configContent) configContent.style.display = 'flex';
            if (logsContent) logsContent.style.display = 'none';
            setActive('config');
            stopLogPolling();
            loadConfig(); // 切换到配置页时重新加载最新配置
        } else if (pageName === 'logs') {
            if (musicContent) musicContent.style.display = 'none';
            if (configContent) configContent.style.display = 'none';
            if (logsContent) logsContent.style.display = 'flex';
            setActive('logs');
            startLogPolling();
        }
    }

    // --- 运行日志页面 ---
    const LOG_BUFFER_LIMIT = 3000;
    let logEntries = [];
    let logLastSeq = 0;
    let logPollTimer = null;

    async function fetchLogs(reset = false) {
        const view = document.getElementById('log-view');
        if (!view) return;
        try {
            const after = reset ? 0 : logLastSeq;
            const limit = reset ? 2000 : 1000;
            const response = await fetch(`/api/logs?after=${after}&limit=${limit}`);
            const data = await response.json();
            const logs = data.logs || [];
            if (reset) {
                logEntries = [];
            }
            logs.forEach(item => {
                if (!logEntries.length || item.seq > logLastSeq) {
                    logEntries.push(item);
                    logLastSeq = Math.max(logLastSeq, item.seq);
                }
            });
            if (logEntries.length > LOG_BUFFER_LIMIT) {
                logEntries = logEntries.slice(-LOG_BUFFER_LIMIT);
            }
            renderLogs();
        } catch (error) {
            console.error('获取日志失败:', error);
        }
    }

    function renderLogs() {
        const view = document.getElementById('log-view');
        if (!view) return;
        const onlyError = document.getElementById('log-only-error');
        const shouldFilter = onlyError && onlyError.checked;
        const entries = shouldFilter
            ? logEntries.filter(e => ['ERROR', 'WARNING', 'WARN', 'CRITICAL'].includes((e.level || '').toUpperCase()))
            : logEntries;

        view.textContent = entries.length
            ? entries.map(e => {
                const t = new Date((e.ts || 0) * 1000);
                const hh = String(t.getHours()).padStart(2, '0');
                const mm = String(t.getMinutes()).padStart(2, '0');
                const ss = String(t.getSeconds()).padStart(2, '0');
                return `[${hh}:${mm}:${ss}] ${e.message}`;
            }).join('\n')
            : '（暂无日志）';

        const status = document.getElementById('log-status');
        if (status) {
            status.textContent = shouldFilter
                ? `显示 ${entries.length} / 共 ${logEntries.length} 条`
                : `共 ${logEntries.length} 条`;
        }

        const autoScroll = document.getElementById('log-auto-scroll');
        if (!autoScroll || autoScroll.checked) {
            view.scrollTop = view.scrollHeight;
        }
    }

    function startLogPolling() {
        fetchLogs(true);
        if (logPollTimer) return;
        logPollTimer = setInterval(() => {
            const auto = document.getElementById('log-auto-refresh');
            if (!auto || auto.checked) fetchLogs(false);
        }, 2000);
    }

    function stopLogPolling() {
        if (logPollTimer) {
            clearInterval(logPollTimer);
            logPollTimer = null;
        }
    }

    function setupLogsPage() {
        const refreshBtn = document.getElementById('log-refresh-btn');
        const clearBtn = document.getElementById('log-clear-btn');
        const onlyError = document.getElementById('log-only-error');
        if (refreshBtn) refreshBtn.addEventListener('click', () => fetchLogs(true));
        if (onlyError) onlyError.addEventListener('change', renderLogs);
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                const clearOk = await uiConfirm({
                    title: '清空日志',
                    message: '将同时清空页面显示与服务器端日志缓冲。',
                    confirmText: '清空',
                    tone: 'warning',
                });
                if (!clearOk) return;
                try {
                    await fetch('/api/logs/clear', { method: 'POST' });
                } catch (error) {
                    console.error('清空日志失败:', error);
                }
                logEntries = [];
                logLastSeq = 0;
                await fetchLogs(true);
            });
        }
    }
    
    async function loadConfig() {
        try {
            const response = await fetch('/api/config');
            const data = await response.json();
            const config = data.config;

            // 填充表单字段
            fillFormWithConfig(config);
            // 填充默认下载位置（从配置读取，仅展示）
            const defaultDirInput = document.getElementById('default-download-dir');
            if (defaultDirInput) {
                defaultDirInput.value = config.download?.default_dir || '/app/downloads/save';
            }
            // 填充监控歌单下载位置
            loadMonitoredDirs();
        } catch (error) {
            console.error('加载配置失败:', error);
        }
    }

    async function loadMonitoredDirs() {
        const container = document.getElementById('monitored-dir-list');
        if (!container) return;
        try {
            const response = await fetch('/api/monitored-playlists-config');
            const data = await response.json();
            const playlists = data || {};
            const ids = Object.keys(playlists);
            if (ids.length === 0) {
                container.innerHTML = '<div class="text-muted small">暂无监控歌单。先到「音乐」页开启歌单监控，再回来配置。</div>';
                return;
            }
            container.innerHTML = ids.map(id => {
                const pl = playlists[id];
                const hint = pl.resolved_dir || '默认目录';
                return `
                    <div class="mb-2 d-flex align-items-center flex-wrap">
                        <span class="text-truncate me-2" style="min-width: 120px; max-width: 200px;" title="${pl.title}">${pl.title}</span>
                        <input type="text" class="form-control me-2" style="max-width: 320px;" data-playlist-id="${id}"
                               placeholder="留空使用 ${hint}" value="${pl.download_dir || ''}">
                        <div class="form-check form-check-inline mb-0">
                            <input class="form-check-input date-folder-checkbox" type="checkbox"
                                   id="date-folder-${id}" data-playlist-id="${id}" ${pl.date_folder ? 'checked' : ''}>
                            <label class="form-check-label" for="date-folder-${id}" title="勾选后保存到 ${hint}/YYMMDD/">
                                按日期建文件夹
                            </label>
                        </div>
                    </div>`;
            }).join('');
        } catch (error) {
            console.error('加载监控歌单目录失败:', error);
        }
    }

    async function saveMonitoredDirs() {
        const container = document.getElementById('monitored-dir-list');
        if (!container) return true;
        const inputs = container.querySelectorAll('input[data-playlist-id][type="text"]');
        if (inputs.length === 0) return true;
        const payload = {};
        inputs.forEach(inp => {
            const id = inp.dataset.playlistId;
            const checkbox = container.querySelector(`.date-folder-checkbox[data-playlist-id="${id}"]`);
            payload[id] = {
                download_dir: inp.value.trim(),
                date_folder: checkbox ? checkbox.checked : false,
            };
        });
        try {
            const response = await fetch('/api/monitored-playlists-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error('保存失败');
            return true;
        } catch (error) {
            console.error('保存监控歌单目录失败:', error);
            return false;
        }
    }

    function fillFormWithConfig(config) {
        // 获取所有表单字段
        const formFields = document.querySelectorAll('#config-form [name]');
        
        formFields.forEach(field => {
            const fieldName = field.name;
            const value = getNestedValue(config, fieldName);
            
            if (field.type === 'checkbox') {
                field.checked = Boolean(value);
            } else {
                field.value = value || '';
            }
        });
        
        // 更新动态字段显示
        toggleWebhookFields();
        toggleWecomFields();
        toggleLyricFields();
    }
    
    function getNestedValue(obj, path) {
        return path.split('.').reduce((acc, key) => {
            return acc && acc[key] !== undefined ? acc[key] : '';
        }, obj);
    }
    
    async function handleConfigSubmit(e) {
        e.preventDefault();

        const formData = new FormData(e.target);
        const configData = {};

        // 构建配置对象
        for (const [name, value] of formData.entries()) {
            setNestedValue(configData, name, value === 'on' ? true : value);
        }

        // 未勾选的 checkbox 不会出现在 FormData 中，需显式设为 false
        document.querySelectorAll('#config-form input[type="checkbox"]').forEach(cb => {
            const name = cb.name;
            if (!cb.checked && name) {
                setNestedValue(configData, name, false);
            }
        });

        try {
            const response = await fetch('/api/config', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(configData)
            });

            if (response.ok) {
                // 一并保存监控歌单下载目录
                const dirsOk = await saveMonitoredDirs();
                uiAlert(dirsOk ? '配置保存成功！' : '配置已保存，但歌单下载目录保存失败。');
            } else {
                throw new Error('配置保存失败');
            }
        } catch (error) {
            console.error('保存配置失败:', error);
            uiAlert('保存配置失败，请查看控制台了解详情。');
        }
    }
    
    function setNestedValue(obj, path, value) {
        const keys = path.split('.');
        let current = obj;
        
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key]) {
                current[key] = {};
            }
            current = current[key];
        }
        
        current[keys[keys.length - 1]] = value;
    }
    
    function toggleWebhookFields() {
        const enabled = document.getElementById('webhook-enabled').checked;
        const container = document.getElementById('webhook-url-container');
        container.style.display = enabled ? 'block' : 'none';
    }

    function toggleBarkFields() {
        const enabled = document.getElementById('bark-enabled').checked;
        const container = document.getElementById('bark-config-container');
        container.style.display = enabled ? 'block' : 'none';
    }

    function toggleWecomFields() {
        const enabled = document.getElementById('wecom-enabled').checked;
        const container = document.getElementById('wecom-config-container');
        container.style.display = enabled ? 'block' : 'none';
    }

    function toggleLyricFields() {
        const enabled = document.getElementById('write-lyrics').checked;
        const container = document.getElementById('lyric-options-container');
        container.style.display = enabled ? 'block' : 'none';
    }
});
