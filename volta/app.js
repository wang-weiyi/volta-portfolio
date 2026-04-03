// ══════════════════════════════════════════════════════════════
//  在下面填入你的配置（参考 setup-guide.html 第5步）
// ══════════════════════════════════════════════════════════════
const CONFIG = {
  supabase: {
    url: 'https://bbwgucxjmdrcyhebicwf.supabase.co',   // ← 替换
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJid2d1Y3hqbWRyY3loZWJpY3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMjIzNzAsImV4cCI6MjA5MDc5ODM3MH0.w4aWqwp6maBL9a9HTRqGlhRucRQJBTvBSvF7DI9YRrc',                   // ← 替换
  },
  cloudinary: {
    cloudName:    'dipaqqlxf',               // ← 替换
    uploadPreset: 'volta_uploads',                 // ← 如果改了 preset 名就改这里
  }
};
// ══════════════════════════════════════════════════════════════

// ── Supabase 轻量客户端 ────────────────────────────────────────
const SB = (() => {
  const { url, key } = CONFIG.supabase;
  let _session = null;

  async function req(path, opts = {}) {
    const headers = {
      'apikey': key,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...opts.headers
    };
    if (_session?.access_token) {
      headers['Authorization'] = 'Bearer ' + _session.access_token;
    }
    const res = await fetch(url + path, { ...opts, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  return {
    // ── Auth ──
    async signIn(email, password) {
      const data = await req('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      _session = data;
      return data;
    },
    signOut() { _session = null; },
    getSession() { return _session; },
    isLoggedIn() { return !!_session?.access_token; },

    // ── Projects ──
    async getProjects() {
      return req('/rest/v1/projects?order=created_at.asc&select=*,sub_projects(*)');
    },
    async getProject(id) {
      const rows = await req(`/rest/v1/projects?id=eq.${id}&select=*,sub_projects(*)`);
      return rows[0] || null;
    },
    async addProject(data) {
      const rows = await req('/rest/v1/projects', { method: 'POST', body: JSON.stringify(data) });
      return rows[0];
    },
    async updateProject(id, data) {
      const rows = await req(`/rest/v1/projects?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(data) });
      return rows[0];
    },
    async deleteProject(id) {
      await req(`/rest/v1/projects?id=eq.${id}`, { method: 'DELETE' });
    },

    // ── SubProjects ──
    async addSubProject(data) {
      const rows = await req('/rest/v1/sub_projects', { method: 'POST', body: JSON.stringify(data) });
      return rows[0];
    },
    async deleteSubProject(id) {
      await req(`/rest/v1/sub_projects?id=eq.${id}`, { method: 'DELETE' });
    },

    // ── Posts ──
    async getPosts(filter = {}) {
      let qs = 'order=created_at.desc&select=*';
      if (filter.type)          qs += `&type=eq.${filter.type}`;
      if (filter.projectId)     qs += `&project_id=eq.${filter.projectId}`;
      if (filter.subProjectId)  qs += `&sub_project_id=eq.${filter.subProjectId}`;
      if (filter.noProject)     qs += '&project_id=is.null';
      return req(`/rest/v1/posts?${qs}`);
    },
    async addPost(data) {
      // Supabase column names use snake_case
      const payload = {
        type:           data.type,
        title:          data.title,
        content:        data.content || '',
        cover_image:    data.coverImage || null,
        images:         data.images || [],
        tags:           data.tags || [],
        project_id:     data.projectId || null,
        sub_project_id: data.subProjectId || null,
      };
      const rows = await req('/rest/v1/posts', { method: 'POST', body: JSON.stringify(payload) });
      return rows[0];
    },
    async deletePost(id) {
      await req(`/rest/v1/posts?id=eq.${id}`, { method: 'DELETE' });
    },
  };
})();

// ── Cloudinary 图片上传 ────────────────────────────────────────
async function uploadImage(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CONFIG.cloudinary.uploadPreset);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CONFIG.cloudinary.cloudName}/image/upload`,
    { method: 'POST', body: fd }
  );
  if (!res.ok) throw new Error('图片上传失败');
  const data = await res.json();
  return data.secure_url;  // 永久 HTTPS URL
}

async function uploadImages(files) {
  return Promise.all(Array.from(files).map(uploadImage));
}

// ── Uploader UI 组件 ────────────────────────────────────────────
// 返回 { mount, getFiles, reset }
// mount 之后用户选图片，getFiles() 返回 File 数组，提交时再统一上传
function makeUploader() {
  let files = [];

  const self = {
    mount(zone, input, preview) {
      zone.onclick    = () => input.click();
      zone.ondragover = e => { e.preventDefault(); zone.style.borderColor = 'rgba(200,255,0,0.5)'; };
      zone.ondragleave= () => { zone.style.borderColor = ''; };
      zone.ondrop     = e => { e.preventDefault(); zone.style.borderColor = ''; self._add(e.dataTransfer.files, preview); };
      input.onchange  = () => { self._add(input.files, preview); input.value = ''; };
    },
    _add(fileList, preview) {
      Array.from(fileList).forEach(f => {
        files.push(f);
        const url = URL.createObjectURL(f);
        const item = document.createElement('div');
        item.className = 'upload-preview-item';
        item.innerHTML = `<img src="${url}"><div class="rm">✕</div>`;
        item.querySelector('.rm').onclick = () => {
          files = files.filter(x => x !== f);
          item.remove();
          URL.revokeObjectURL(url);
        };
        preview.appendChild(item);
      });
    },
    getFiles()      { return [...files]; },
    hasFiles()      { return files.length > 0; },
    reset(preview)  { files = []; if (preview) preview.innerHTML = ''; }
  };
  return self;
}

// ── 通用 Confirm 对话框 ────────────────────────────────────────
let _cResolve = () => {};
function confirm2(title, msg) {
  document.getElementById('cTitle').textContent = title;
  document.getElementById('cMsg').textContent   = msg;
  document.getElementById('confirmOverlay').classList.add('open');
  return new Promise(res => {
    _cResolve = v => {
      document.getElementById('confirmOverlay').classList.remove('open');
      res(v);
    };
  });
}
// 需要在页面里调用这个来绑定 confirm 按钮
function initConfirm() {
  document.getElementById('confirmOverlay').addEventListener('click',
    e => { if (e.target.id === 'confirmOverlay') _cResolve(false); }
  );
}
// 暴露给 HTML onclick
window.cResolve = v => _cResolve(v);

// ── Toast 提示 ────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:2rem;right:2rem;z-index:9999;
    padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;
    background:${type === 'err' ? '#ff4444' : '#c8ff00'};
    color:${type === 'err' ? '#fff' : '#000'};
    box-shadow:0 4px 20px rgba(0,0,0,.4);
    animation:fadeUp .2s ease;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Auth state in sessionStorage (页面刷新保持登录) ──────────
(function restoreSession() {
  try {
    const raw = sessionStorage.getItem('volta_session');
    if (raw) {
      const s = JSON.parse(raw);
      // Re-inject so SB client knows we're logged in
      SB.signIn.__restore = true;
      // Use internal setter via a tiny hack
      SB._restoreSession = s;
      // Patch SB to accept restored session
    }
  } catch(e) {}
})();

// ── 持久化登录 session ─────────────────────────────────────────
// 覆盖 SB 里的 _session 管理，使其跨页面刷新
const _origSignIn = SB.signIn.bind(SB);
SB.signIn = async function(email, password) {
  const data = await _origSignIn(email, password);
  try { sessionStorage.setItem('volta_session', JSON.stringify(data)); } catch(e) {}
  return data;
};
const _origSignOut = SB.signOut.bind(SB);
SB.signOut = function() {
  _origSignOut();
  sessionStorage.removeItem('volta_session');
};

// Restore on load
(function() {
  try {
    const raw = sessionStorage.getItem('volta_session');
    if (raw) {
      const s = JSON.parse(raw);
      // Directly inject into closure via re-calling with stored token
      // Since we can't access _session directly, we monkey-patch getSession
      const origGet = SB.getSession.bind(SB);
      SB.getSession   = () => s;
      SB.isLoggedIn   = () => !!s?.access_token;
      // Also patch req headers by storing on object
      SB._session_raw = s;
      // Fix: patch the internal req by overriding headers getter
      // Simpler: just store token and inject it via the fetch override below
    }
  } catch(e) {}
})();

// Ensure auth token is always sent if we have a stored session
const _origFetch = window.fetch;
window.fetch = function(input, init = {}) {
  // Only inject for supabase REST calls
  if (typeof input === 'string' && input.startsWith(CONFIG.supabase.url)) {
    try {
      const raw = sessionStorage.getItem('volta_session');
      if (raw) {
        const s = JSON.parse(raw);
        if (s?.access_token) {
          init.headers = {
            ...(init.headers || {}),
            'Authorization': 'Bearer ' + s.access_token,
            'apikey': CONFIG.supabase.key,
          };
        }
      }
    } catch(e) {}
  }
  return _origFetch(input, init);
};

// Also keep SB.isLoggedIn accurate after restore
(function() {
  try {
    const raw = sessionStorage.getItem('volta_session');
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.access_token) {
        SB.isLoggedIn = () => true;
        SB.getSession = () => s;
      }
    }
  } catch(e) {}
})();

// ── 格式化日期 ────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;
}

// ── Color picker 组件 ─────────────────────────────────────────
const PROJ_COLORS = ['#7b61ff','#ff6b35','#c8ff00','#00d4ff','#ff3cac','#f5a623','#50fa7b'];

function buildColorPicker(containerId, selected, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = PROJ_COLORS.map(c => `
    <div class="swatch ${c===selected?'on':''}" style="background:${c}" data-c="${c}"
      onclick="pickColor(this,'${containerId}',event)"></div>
  `).join('');
  el._onChange = onChange;
}
window.pickColor = function(el, containerId, e) {
  if (e) e.stopPropagation();
  document.getElementById(containerId).querySelectorAll('.swatch').forEach(s => s.classList.remove('on'));
  el.classList.add('on');
  const wrap = document.getElementById(containerId);
  wrap._onChange && wrap._onChange(el.dataset.c);
};
