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
            alert('请输入有效的手机号');
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
                alert(data.message);
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
                alert(data.message);
                sendCodeBtn.disabled = false;
                sendCodeBtn.textContent = '发送验证码';
            }
        } catch (error) {
            console.error('发送验证码失败:', error);
            alert('发送验证码失败，请稍后重试');
            sendCodeBtn.disabled = false;
            sendCodeBtn.textContent = '发送验证码';
        }
    }
    
    function openCaptchaInNewWindow(captchaUrl) {
        // 在新窗口打开验证码
        window.open(captchaUrl, '_blank', 'width=500,height=600,left=200,top=100');
        
        // 显示友好的提示
        alert('验证码窗口已在新窗口打开\n\n请在新窗口完成验证码验证，验证成功后请返回此页面并再次点击"发送验证码"按钮');
    }
    
    async function handlePhoneLogin() {
        const phoneNumber = document.getElementById('phone-number').value;
        const authCode = document.getElementById('auth-code').value;
        const phoneLoginBtn = document.getElementById('phone-login-btn');
        
        if (!phoneNumber || phoneNumber.length !== 11) {
            alert('请输入有效的手机号');
            return;
        }
        
        if (!authCode || authCode.length !== 6) {
            alert('请输入6位验证码');
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
                alert(data.message);
                window.location.reload();
            } else {
                alert(data.message);
                phoneLoginBtn.disabled = false;
                phoneLoginBtn.textContent = '登录';
            }
        } catch (error) {
            console.error('手机号登录失败:', error);
            alert('登录失败，请稍后重试');
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
                    avatar.src = data.head_url;
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

    async function getUserPlaylists() {
        // ... (This function remains the same as before)
        try {
            const response = await fetch('/api/playlists');
            const playlists = await response.json();
            if (playlists.error) {
                playlistsContainer.innerHTML = `<p class="text-danger">获取歌单失败: ${playlists.error}</p>`;
                return;
            }
            if (playlists.length === 0) {
                playlistsContainer.innerHTML = '<p>你还没有创建或收藏任何歌单。</p>';
                return;
            }
            const createdPlaylists = playlists.filter(p => p.type === 'created');
            const favoritePlaylists = playlists.filter(p => p.type === 'favorite');
            let finalHtml = '';
            const renderPlaylist = (pl) => `
                <div class="list-group-item d-flex justify-content-between align-items-center">
                    <a href="#" class="playlist-item flex-grow-1" data-id="${pl.dissid}" style="text-decoration: none; color: inherit;">
                        ${pl.title} <span class="badge bg-secondary float-end">${pl.subtitle || ''}</span>
                    </a>
                    <button class="btn btn-outline-primary btn-sm ms-2 monitor-btn" data-id="${pl.dissid}" title="监控歌单更新">
                        <i class="bi bi-eye"></i>
                    </button>
                </div>
            `;
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
        } catch (error) {
            console.error('获取歌单失败:', error);
            playlistsContainer.innerHTML = '<p class="text-danger">获取歌单时发生错误。</p>';
        }
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

    async function handleMonitorClick(button) {
        const playlistId = button.dataset.id;
        button.disabled = true;
        try {
            const response = await fetch(`/api/monitor/${playlistId}`, { method: 'POST' });
            const data = await response.json();
            if (data.status === 'success') {
                await updateMonitorButtons();
            } else {
                alert(`操作失败: ${data.message}`);
            }
        } catch (error) {
            console.error('监控操作失败:', error);
        } finally {
            button.disabled = false;
        }
    }

    async function updateMonitorButtons() {
        // ... (This function remains the same as before)
        try {
            const response = await fetch('/api/monitor/status');
            const monitoredIds = await response.json();
            document.querySelectorAll('.monitor-btn').forEach(button => {
                const playlistId = button.dataset.id;
                if (monitoredIds.includes(playlistId)) {
                    button.classList.remove('btn-outline-primary');
                    button.classList.add('btn-primary', 'active');
                    button.innerHTML = '<i class="bi bi-eye-fill"></i>';
                    button.title = "取消监控";
                } else {
                    button.classList.remove('btn-primary', 'active');
                    button.classList.add('btn-outline-primary');
                    button.innerHTML = '<i class="bi bi-eye"></i>';
                    button.title = "监控歌单更新";
                }
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
        songListContainer.addEventListener('click', (e) => {
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
                const name = item.querySelector('span').textContent || '';
                // 已有本地文件：弹窗确认是否重新下载
                if (dlBtn.dataset.hasLocalFile) {
                    if (!confirm(`本地已有该歌曲文件，确定要重新下载吗？\n\n${name}`)) {
                        return;
                    }
                    delete dlBtn.dataset.hasLocalFile;
                }
                dlBtn.textContent = '队列中';
                dlBtn.disabled = true;
                startDownload(mid, name);
            }
        });
    }

    bindSongListDelegation();

    async function searchSongs(keyword) {
        if (!keyword) {
            return;
        }
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
                songListContainer.innerHTML = '<p>没有找到相关歌曲。</p>';
                return;
            }
            allSongs = songs;
            songListContainer.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <span class="text-muted small">搜索 " ${keyword} "，共 ${songs.length} 首</span>
                    <button class="btn btn-outline-secondary btn-sm" id="search-clear-btn">清除</button>
                </div>
                <ul class="list-group"></ul>
            `;
            loadMoreSongs();
            document.getElementById('search-clear-btn').addEventListener('click', () => {
                document.getElementById('song-search-input').value = '';
                songListContainer.innerHTML = '<p>请从左侧选择一个歌单。</p>';
                allSongs = [];
                loadedSongsCount = 0;
                songListContainer.onscroll = null;
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
        // ... (This function remains the same as before)
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
                songListContainer.innerHTML = '<p>这个歌单里没有歌曲。</p>';
                return;
            }
            allSongs = songs;
            songListContainer.innerHTML = `
                <div class="d-grid gap-2 mb-2">
                    <button class="btn btn-success" id="download-all-btn" data-playlist-id="${playlistId}">
                        <i class="bi bi-download"></i> 全部下载 (${allSongs.length}首)
                    </button>
                </div>
                <ul class="list-group"></ul>
            `;
            loadMoreSongs();
            document.getElementById('download-all-btn').addEventListener('click', async (e) => {
                const button = e.currentTarget;
                button.textContent = '正在加入队列...';
                button.disabled = true;
                try {
                    await fetch(`/api/playlist/download/${playlistId}`, { method: 'POST' });
                    alert('已将歌单中所有未下载的歌曲加入下载队列。');
                } catch (error) {
                    console.error('完整下载歌单失败:', error);
                    alert('操作失败，请查看控制台。');
                } finally {
                    button.textContent = `全部下载 (${allSongs.length}首)`;
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
        const songsHtml = songsToLoad.map(song => {
            // 检查是否有本地歌曲信息
            let localInfoHtml = '';
            if (song.local_info) {
                const localInfo = song.local_info;
                localInfoHtml = `
                    <div class="mt-1 small text-muted">
                        <span class="badge bg-info me-2">本地文件</span>
                        <span class="me-2">${localInfo.quality}</span>
                        <span>${formatFileSize(localInfo.size)}</span>
                    </div>
                `;
            }
            return `
                <li class="list-group-item song-item" data-song-mid="${song.mid}" data-song-name="${song.name} - ${song.singer.map(s => s.name).join('/')}">
                    <div class="d-flex justify-content-between align-items-center">
                        <span>${song.name} - ${song.singer.map(s => s.name).join('/')}</span>
                        <div class="btn-group">
                            <button class="btn btn-outline-success btn-sm play-btn" title="播放">
                                <i class="bi bi-play-fill"></i>
                            </button>
                            <button class="btn btn-primary btn-sm download-btn">下载</button>
                        </div>
                    </div>
                    ${localInfoHtml}
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

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    async function playSong(songMid, songName) {
        if (currentPlayback.mid === songMid && !audioPlayer.paused && !audioPlayer.ended) {
            // 点击同一首歌且正在播放 → 暂停
            audioPlayer.pause();
            return;
        }
        try {
            playerSongName.textContent = songName || songMid;
            playerBar.style.display = 'block';
            document.body.classList.add('has-player');
            const response = await fetch(`/api/play/${songMid}`);
            if (!response.ok) {
                const err = await response.json();
                playerSongName.textContent = `播放失败: ${err.detail || '无法获取链接'}`;
                return;
            }
            const data = await response.json();
            currentPlayback = { mid: songMid, name: songName || '' };
            audioPlayer.src = data.url;
            await audioPlayer.play();
            playerToggleIcon.className = 'bi bi-pause-fill';
            syncPlayButtons();
        } catch (error) {
            console.error('播放失败:', error);
            playerSongName.textContent = '播放失败';
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
        // 同步歌曲行播放按钮：正在播放的显示暂停图标
        const playing = !audioPlayer.paused && !audioPlayer.ended && currentPlayback.mid;
        document.querySelectorAll('.play-btn').forEach(btn => {
            const item = btn.closest('.song-item');
            const isCurrent = item && item.dataset.songMid === currentPlayback.mid;
            if (playing && isCurrent) {
                btn.innerHTML = '<i class="bi bi-pause-fill"></i>';
                btn.classList.add('active');
            } else {
                btn.innerHTML = '<i class="bi bi-play-fill"></i>';
                btn.classList.remove('active');
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

    audioPlayer.addEventListener('play', () => { playerToggleIcon.className = 'bi bi-pause-fill'; syncPlayButtons(); });
    audioPlayer.addEventListener('pause', () => { playerToggleIcon.className = 'bi bi-play-fill'; syncPlayButtons(); });
    audioPlayer.addEventListener('ended', () => {
        playerToggleIcon.className = 'bi bi-play-fill';
        updatePlayerFill(0);
        playerTime.textContent = '0:00 / 0:00';
        syncPlayButtons();
    });

    document.getElementById('player-close-btn').addEventListener('click', () => {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        playerBar.style.display = 'none';
        document.body.classList.remove('has-player');
        playerSongName.textContent = '未在播放';
        currentPlayback = { mid: null, name: '' };
        updatePlayerFill(0);
        playerTime.textContent = '0:00 / 0:00';
        syncPlayButtons();
    });

    async function startDownload(songMid, songName) {
        // ... (This function remains the same as before)
        try {
            await fetch(`/api/download/${songMid}?song_name=${encodeURIComponent(songName)}`, { method: 'POST' });
        } catch (error) {
            console.error('启动下载失败:', error);
        }
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
                if (tasks[mid].status === 'completed') {
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

        if (task) {
            switch (task.status) {
                case 'completed':
                    button.textContent = '已下载';
                    button.disabled = true;
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
                    button.textContent = '失败';
                    button.disabled = true; // Or enable for retry
                    button.className = 'btn btn-danger btn-sm download-btn';
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
            // 有本地歌曲文件，但没有任务记录：可点击重新下载
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
        const isCompleted = task.status === 'completed';
        const checkboxClass = isCompleted ? 'completed-task-checkbox' : 'ongoing-task-checkbox';

        const checkboxHtml = `
            <div class="form-check me-3">
                <input class="form-check-input ${checkboxClass}" type="checkbox" value="${task.mid}" id="task-${task.mid}">
            </div>`;

        switch (task.status) {
            case 'downloading':
                statusContent = `<div class="progress" style="height: 20px;"><div class="progress-bar" role="progressbar" style="width: ${task.progress || 0}%;">${task.progress || 0}%</div></div>`;
                actionButtons = `<button class="btn btn-warning btn-sm ms-2 cancel-btn" data-mid="${task.mid}" title="取消"><i class="bi bi-x-lg"></i></button>`;
                break;
            case 'completed':
                statusContent = `<span class="badge bg-success">已完成</span>`;
                break;
            case 'failed':
                statusContent = `<span class="badge bg-danger">下载失败</span>`;
                errorReason = `<div class="text-danger small mt-1">${task.error || '未知错误'}</div>`;
                actionButtons = `<button class="btn btn-info btn-sm ms-2 retry-btn" data-mid="${task.mid}" title="重试"><i class="bi bi-arrow-clockwise"></i></button><button class="btn btn-danger btn-sm ms-2 remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
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
                
                errorReason = `<div class="text-warning small mt-1">账号超出下载限制, ${countdownText} 后自动重试</div>`;
                actionButtons = `<button class="btn btn-danger btn-sm ms-2 remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
                break;
            case 'queued':
                 statusContent = `<span class="badge bg-secondary">队列中</span>`;
                 actionButtons = `<button class="btn btn-warning btn-sm ms-2 cancel-btn" data-mid="${task.mid}" title="取消"><i class="bi bi-x-lg"></i></button>`;
                 break;
            case 'cancelled':
                statusContent = `<span class="badge bg-dark">已取消</span>`;
                actionButtons = `<button class="btn btn-danger btn-sm ms-2 remove-btn" data-mid="${task.mid}" title="移除"><i class="bi bi-trash"></i></button>`;
                break;
            default:
                statusContent = `<span class="badge bg-dark">${task.status}</span>`;
        }
        const qualityBadge = task.quality ? `<span class="badge bg-info me-2">${task.quality}</span>` : '';
        return `
            <li class="list-group-item">
                <div class="d-flex justify-content-between align-items-center">
                    ${checkboxHtml}
                    <label class="form-check-label flex-grow-1 text-truncate" for="task-${task.mid}" title="${task.song_name}" style="cursor: pointer;">
                        ${task.song_name}
                    </label>
                    <div class="d-flex align-items-center">
                        ${qualityBadge}
                        <div style="width: 100px;">${statusContent}</div>
                        ${actionButtons}
                    </div>
                </div>
                ${errorReason}
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
            alert(data.message || '操作完成');
            updateDownloadStatus();
        } catch (error) {
            console.error('全部重试失败:', error);
            alert('操作失败，请查看控制台。');
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
                alert('请至少选择一个进行中的任务。');
                return;
            }
            const action = actionTarget.dataset.action; // 'cancel' or 'remove'
            const confirmMessage = `确定要对选中的 ${selectedMids.length} 个任务执行 "${action === 'cancel' ? '取消' : '移除'}" 操作吗？`;
            
            if (confirm(confirmMessage)) {
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
                alert('请至少选择一个任务。');
                return;
            }
            const deleteFiles = actionTarget.dataset.deleteFiles === 'true';
            let confirmMessage = `确定要从列表中移除选中的 ${selectedMids.length} 个任务吗？`;
            if (deleteFiles) {
                confirmMessage = `【高危操作】\n\n确定要移除并永久删除选中的 ${selectedMids.length} 个文件吗？\n\n此操作不可恢复！`;
            }
            if (confirm(confirmMessage)) {
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
        
        // 加载配置
        loadConfig();
        
        // 表单提交
        document.getElementById('config-form').addEventListener('submit', handleConfigSubmit);
        
        // 重置按钮：恢复默认配置
        document.getElementById('reset-config-btn').addEventListener('click', async () => {
            if (!confirm('确定要重置所有配置为默认值吗？')) return;
            try {
                const response = await fetch('/api/config/reset', { method: 'POST' });
                const data = await response.json();
                if (data.config) {
                    fillFormWithConfig(data.config);
                    alert('配置已重置为默认值。');
                } else {
                    alert('重置失败，请查看控制台。');
                }
            } catch (error) {
                console.error('重置配置失败:', error);
                alert('重置配置失败。');
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
    }
    
    function switchToPage(pageName) {
        const musicContent = document.getElementById('music-content');
        const configContent = document.getElementById('config-content');
        const navMusic = document.getElementById('nav-music');
        const navConfig = document.getElementById('nav-config');
        
        if (pageName === 'music') {
            musicContent.style.display = 'flex';
            configContent.style.display = 'none';
            navMusic.classList.add('active');
            navConfig.classList.remove('active');
        } else if (pageName === 'config') {
            musicContent.style.display = 'none';
            configContent.style.display = 'flex';
            navMusic.classList.remove('active');
            navConfig.classList.add('active');
            loadConfig(); // 切换到配置页时重新加载最新配置
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
                defaultDirInput.value = config.download?.default_dir || '/app/downloads';
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
                return `
                    <div class="mb-2 d-flex align-items-center">
                        <span class="text-truncate me-2" style="min-width: 120px; max-width: 200px;" title="${pl.title}">${pl.title}</span>
                        <input type="text" class="form-control" data-playlist-id="${id}"
                               placeholder="留空使用 /app/downloads" value="${pl.download_dir || ''}">
                    </div>`;
            }).join('');
        } catch (error) {
            console.error('加载监控歌单目录失败:', error);
        }
    }

    async function saveMonitoredDirs() {
        const container = document.getElementById('monitored-dir-list');
        if (!container) return true;
        const inputs = container.querySelectorAll('input[data-playlist-id]');
        if (inputs.length === 0) return true;
        const payload = {};
        inputs.forEach(inp => {
            payload[inp.dataset.playlistId] = { download_dir: inp.value.trim() };
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
                alert(dirsOk ? '配置保存成功！' : '配置已保存，但歌单下载目录保存失败。');
            } else {
                throw new Error('配置保存失败');
            }
        } catch (error) {
            console.error('保存配置失败:', error);
            alert('保存配置失败，请查看控制台了解详情。');
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
