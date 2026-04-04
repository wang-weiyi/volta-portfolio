// ══════════════════════════════════════════════════════════════
//  填入你的配置
// ══════════════════════════════════════════════════════════════
const CONFIG = {
  supabase: {
    url: 'https://bbwgucxjmdrcyhebicwf.supabase.co',   // ← 替换
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJid2d1Y3hqbWRyY3loZWJpY3dmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMjIzNzAsImV4cCI6MjA5MDc5ODM3MH0.w4aWqwp6maBL9a9HTRqGlhRucRQJBTvBSvF7DI9YRrc',                   // ← 替换
  },
  cloudinary: {
    cloudName:    'dipaqqlxf',               // ← 替换
    uploadPreset: 'volta_uploads',
  }
};
// ══════════════════════════════════════════════════════════════

// ── Session 持久化（最简实现，无 monkey-patch）────────────────
const Auth = (() => {
  const KEY = 'volta_sess';
  let _tok = null;

  // 页面加载时恢复
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) _tok = JSON.parse(raw).access_token || null;
  } catch(e) {}

  return {
    token()     { return _tok; },
    isLoggedIn(){ return !!_tok; },
    save(data)  { _tok = data.access_token; try { sessionStorage.setItem(KEY, JSON.stringify(data)); } catch(e) {} },
    clear()     { _tok = null; try { sessionStorage.removeItem(KEY); } catch(e) {} },
  };
})();

// ── Supabase 客户端 ───────────────────────────────────────────
const SB = (() => {
  const { url, key } = CONFIG.supabase;

  async function req(path, opts = {}) {
    const headers = {
      'apikey': key,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(Auth.token() ? { 'Authorization': 'Bearer ' + Auth.token() } : {}),
      ...(opts.headers || {}),
    };
    const res = await fetch(url + path, { ...opts, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  return {
    isLoggedIn() { return Auth.isLoggedIn(); },

    // ── Auth ──
    async signIn(email, password) {
      const data = await req('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      Auth.save(data);
      return data;
    },
    signOut() { Auth.clear(); },

    // ── Projects ──
    async getProjects() {
      return req('/rest/v1/projects?order=created_at.asc&select=*,sub_projects(*)');
    },
    async getProject(id) {
      const rows = await req(`/rest/v1/projects?id=eq.${encodeURIComponent(id)}&select=*,sub_projects(*)`);
      return rows[0] || null;
    },
    async addProject(data) {
      const rows = await req('/rest/v1/projects', { method:'POST', body:JSON.stringify(data) });
      return rows[0];
    },
    async updateProject(id, data) {
      const rows = await req(`/rest/v1/projects?id=eq.${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(data) });
      return rows[0];
    },
    async deleteProject(id) {
      await req(`/rest/v1/projects?id=eq.${encodeURIComponent(id)}`, { method:'DELETE' });
    },

    // ── SubProjects ──
    async addSubProject(data) {
      const rows = await req('/rest/v1/sub_projects', { method:'POST', body:JSON.stringify(data) });
      return rows[0];
    },
    async deleteSubProject(id) {
      await req(`/rest/v1/sub_projects?id=eq.${encodeURIComponent(id)}`, { method:'DELETE' });
    },

    // ── Posts ──
    // filter: { gallery, projectId, subProjectId }
    async getPosts(filter = {}) {
      let qs = 'order=created_at.desc&select=*';
      if (filter.gallery === true)       qs += '&show_in_gallery=eq.true';
      if (filter.gallery === false)      qs += '&show_in_gallery=eq.false';
      if (filter.projectId)              qs += `&project_id=eq.${encodeURIComponent(filter.projectId)}`;
      if (filter.subProjectId)           qs += `&sub_project_id=eq.${encodeURIComponent(filter.subProjectId)}`;
      if (filter.noProject === true)     qs += '&project_id=is.null';
      return req(`/rest/v1/posts?${qs}`);
    },
    async getPost(id) {
      const rows = await req(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=*`);
      return rows[0] || null;
    },
    async addPost(data) {
      const payload = {
        title:           data.title          || '',
        content:         data.content        || '',
        images:          data.images         || [],
        tags:            data.tags           || [],
        show_in_gallery: data.showInGallery  ?? false,
        project_id:      data.projectId      || null,
        sub_project_id:  data.subProjectId   || null,
      };
      const rows = await req('/rest/v1/posts', { method:'POST', body:JSON.stringify(payload) });
      return rows[0];
    },
    async updatePost(id, data) {
      const rows = await req(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(data) });
      return rows[0];
    },
    async deletePost(id) {
      await req(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, { method:'DELETE' });
    },

    // ── Articles ──
    async getArticles(publishedOnly = true) {
      let qs = 'order=created_at.desc&select=*';
      if (publishedOnly) qs += '&status=eq.published';
      return req(`/rest/v1/articles?${qs}`);
    },
    async getArticle(id) {
      const rows = await req(`/rest/v1/articles?id=eq.${encodeURIComponent(id)}&select=*`);
      return rows[0] || null;
    },
    async addArticle(data) {
      const rows = await req('/rest/v1/articles', { method:'POST', body:JSON.stringify(data) });
      return rows[0];
    },
    async updateArticle(id, data) {
      const payload = { ...data, updated_at: new Date().toISOString() };
      const rows = await req(`/rest/v1/articles?id=eq.${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(payload) });
      return rows[0];
    },
    async deleteArticle(id) {
      await req(`/rest/v1/articles?id=eq.${encodeURIComponent(id)}`, { method:'DELETE' });
    },
  };
})();

// ── Cloudinary ────────────────────────────────────────────────
async function uploadImage(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CONFIG.cloudinary.uploadPreset);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CONFIG.cloudinary.cloudName}/image/upload`,
    { method:'POST', body:fd }
  );
  if (!res.ok) throw new Error('图片上传失败');
  const data = await res.json();
  return data.secure_url;
}
async function uploadImages(files) {
  return Promise.all(Array.from(files).map(uploadImage));
}

// ── Uploader 组件（新增图片，追加到现有列表）────────────────
function makeUploader() {
  let _files = [];
  const self = {
    mount(zone, input, preview) {
      zone.onclick     = () => input.click();
      zone.ondragover  = e => { e.preventDefault(); zone.style.borderColor='rgba(200,255,0,.5)'; };
      zone.ondragleave = () => { zone.style.borderColor=''; };
      zone.ondrop      = e => { e.preventDefault(); zone.style.borderColor=''; self._add(e.dataTransfer.files, preview); };
      input.onchange   = () => { self._add(input.files, preview); input.value=''; };
    },
    _add(fileList, preview) {
      Array.from(fileList).forEach(f => {
        _files.push(f);
        const url = URL.createObjectURL(f);
        const item = document.createElement('div');
        item.className = 'upload-preview-item';
        item.innerHTML = `<img src="${url}"><div class="rm">✕</div>`;
        item.querySelector('.rm').onclick = () => {
          _files = _files.filter(x => x !== f);
          item.remove();
          URL.revokeObjectURL(url);
        };
        preview.appendChild(item);
      });
    },
    getFiles()     { return [..._files]; },
    reset(preview) { _files = []; if (preview) preview.innerHTML = ''; },
  };
  return self;
}

// ── 图片列表编辑器（用于编辑已有帖子的 images[]）────────────
// 渲染一组已有 URL，每张可删除，可追加新图片
// 返回 getImages() → 最终 URL 数组（含新上传的）
function makeImageEditor(containerEl, initialUrls = []) {
  let _urls   = [...initialUrls]; // 已有 URL
  let _newFiles = [];             // 待上传的新文件

  function render() {
    containerEl.innerHTML = '';
    _urls.forEach((u, i) => {
      const item = document.createElement('div');
      item.className = 'upload-preview-item';
      item.style.position = 'relative';
      item.innerHTML = `<img src="${u}"><div class="rm" data-i="${i}">✕</div>`;
      item.querySelector('.rm').onclick = () => {
        _urls.splice(i, 1);
        render();
      };
      containerEl.appendChild(item);
    });
    // 新文件预览
    _newFiles.forEach((f, i) => {
      const url = URL.createObjectURL(f);
      const item = document.createElement('div');
      item.className = 'upload-preview-item';
      item.style.outline = '2px solid var(--acc)';
      item.innerHTML = `<img src="${url}"><div class="rm">✕</div>`;
      item.querySelector('.rm').onclick = () => {
        _newFiles.splice(i, 1);
        URL.revokeObjectURL(url);
        render();
      };
      containerEl.appendChild(item);
    });
  }

  render();

  return {
    addFiles(fileList) {
      _newFiles.push(...Array.from(fileList));
      render();
    },
    async getImages() {
      // 上传新文件，合并到 URL 列表
      if (_newFiles.length) {
        const newUrls = await uploadImages(_newFiles);
        _urls = [..._urls, ...newUrls];
        _newFiles = [];
        render();
      }
      return [..._urls];
    },
    reset(urls = []) { _urls = [...urls]; _newFiles = []; render(); },
  };
}

// ── Toast ────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2800);
}

// ── Confirm dialog ────────────────────────────────────────────
let _cResolve = () => {};
function confirm2(title, msg) {
  document.getElementById('cTitle').textContent = title;
  document.getElementById('cMsg').textContent   = msg;
  document.getElementById('confirmOverlay').classList.add('open');
  return new Promise(res => {
    _cResolve = v => { document.getElementById('confirmOverlay').classList.remove('open'); res(v); };
  });
}
function initConfirm() {
  document.getElementById('confirmOverlay').addEventListener('click',
    e => { if (e.target.id === 'confirmOverlay') _cResolve(false); }
  );
}
window.cResolve = v => _cResolve(v);

// ── Auth UI helper ────────────────────────────────────────────
function applyAuthUI() {
  document.body.classList.toggle('is-auth', SB.isLoggedIn());
}

// ── Helpers ──────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;
}

function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const PROJ_COLORS = ['#7b61ff','#ff6b35','#c8ff00','#00d4ff','#ff3cac','#f5a623','#50fa7b'];

function buildColorPicker(containerId, selected, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = PROJ_COLORS.map(c =>
    `<div class="swatch ${c===selected?'on':''}" style="background:${c}" data-c="${c}"
      onclick="pickColor(this,'${containerId}',event)"></div>`
  ).join('');
  el._onChange = onChange;
}
window.pickColor = function(el, containerId, e) {
  if (e) e.stopPropagation();
  document.getElementById(containerId).querySelectorAll('.swatch').forEach(s => s.classList.remove('on'));
  el.classList.add('on');
  const wrap = document.getElementById(containerId);
  wrap._onChange && wrap._onChange(el.dataset.c);
};

// ── 图片网格 HTML 生成器 ──────────────────────────────────────
function buildImgBlock(imgs, postId) {
  if (!imgs || !imgs.length) return '';
  const n = imgs.length;
  const lb = (idx) => postId ? `onclick="openLb('${postId}',${idx})"` : '';

  // 1张
  if (n === 1) {
    return `<div class="tl-images n1">
      <img src="${esc(imgs[0])}" loading="lazy" ${lb(0)} />
    </div>`;
  }

  // 2张：左右各半
  if (n === 2) {
    return `<div class="tl-images n2">
      <img src="${esc(imgs[0])}" loading="lazy" ${lb(0)} />
      <img src="${esc(imgs[1])}" loading="lazy" ${lb(1)} />
    </div>`;
  }

  // 3张：左大（全高）+ 右上下两格
  if (n === 3) {
    return `<div class="tl-images n3">
      <img src="${esc(imgs[0])}" loading="lazy" ${lb(0)} />
      <img src="${esc(imgs[1])}" loading="lazy" ${lb(1)} />
      <img src="${esc(imgs[2])}" loading="lazy" ${lb(2)} />
    </div>`;
  }

  // 4张：2×2 网格
  if (n === 4) {
    return `<div class="tl-images n4">
      <img src="${esc(imgs[0])}" loading="lazy" ${lb(0)} />
      <img src="${esc(imgs[1])}" loading="lazy" ${lb(1)} />
      <img src="${esc(imgs[2])}" loading="lazy" ${lb(2)} />
      <img src="${esc(imgs[3])}" loading="lazy" ${lb(3)} />
    </div>`;
  }

  // 5张及以上：左大（全高）+ 右上下两格，右下叠加剩余计数
  const extra = n - 3;
  return `<div class="tl-images n5plus">
    <img src="${esc(imgs[0])}" loading="lazy" ${lb(0)} />
    <div class="img-slot" ${lb(1)}>
      <img src="${esc(imgs[1])}" loading="lazy" />
    </div>
    <div class="img-slot" ${lb(2)}>
      <img src="${esc(imgs[2])}" loading="lazy" />
      ${extra > 0 ? `<div class="more-badge">+${extra}</div>` : ''}
    </div>
  </div>`;
}
window.buildImgBlock = buildImgBlock;
const LB = (() => {
  let imgs = [], idx = 0;
  let _el, _img, _prev, _next, _strip, _info, _title, _text, _tags;

  function init() {
    _el    = document.getElementById('lb');         if (!_el) return false;
    _img   = document.getElementById('lbImg');
    _prev  = document.getElementById('lbPrev');
    _next  = document.getElementById('lbNext');
    _strip = document.getElementById('lbStrip');
    _info  = document.getElementById('lbInfo');
    _title = document.getElementById('lbTitle');
    _text  = document.getElementById('lbText');
    _tags  = document.getElementById('lbTags');
    _el.querySelector('.lb-backdrop')?.addEventListener('click', () => LB.close());
    document.addEventListener('keydown', e => {
      if (!_el?.classList.contains('open')) return;
      if (e.key==='Escape')      LB.close();
      if (e.key==='ArrowLeft')   LB.step(-1);
      if (e.key==='ArrowRight')  LB.step(1);
    });
    return true;
  }

  function render() {
    if (!_img) return;
    _img.src = imgs[idx] || '';
    if (_strip) {
      _strip.style.display = imgs.length > 1 ? 'flex' : 'none';
      if (imgs.length > 1)
        _strip.innerHTML = imgs.map((u,i) =>
          `<img src="${u}" class="${i===idx?'active':''}" onclick="LB.go(${i})" />`
        ).join('');
    }
    if (_prev) _prev.style.display = idx === 0 ? 'none' : 'flex';
    if (_next) _next.style.display = idx === imgs.length-1 ? 'none' : 'flex';
  }

  return {
    open(imageList, startIdx, meta) {
      if (!_el && !init()) return;
      imgs = imageList || [];
      idx  = startIdx  || 0;
      if (_info) {
        const hasInfo = meta && (meta.title || meta.content);
        _info.style.display = hasInfo ? 'block' : 'none';
        if (hasInfo) {
          if (_title) _title.textContent = meta.title || '';
          if (_text)  { _text.textContent = meta.content||''; _text.style.display = meta.content?'block':'none'; }
          if (_tags)  _tags.innerHTML = (meta.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('');
        }
      }
      _el.classList.add('open');
      document.body.style.overflow = 'hidden';
      render();
    },
    close() {
      if (_el) _el.classList.remove('open');
      document.body.style.overflow = '';
      if (_img) _img.src = '';
    },
    go(i)   { idx = i; render(); },
    step(d) { idx = Math.max(0, Math.min(imgs.length-1, idx+d)); render(); },
  };
})();
window.LB = LB;
