/**
 * utils.js — Вспомогательные функции (форматирование ФИО, дат, хеширование, уведомления)
 */

window.AppUtils = (function () {
  'use strict';

  function formatToInitials(nameStr) {
    if (!nameStr) return '';
    const trimmed = nameStr.trim();

    const match3 = trimmed.match(/^([А-Яа-яA-Za-z])[\.\s]+([А-Яа-яA-Za-z])[\.\s]+([А-Яа-яA-Za-z])[\.]?$/);
    if (match3) {
      return `${match3[1].toUpperCase()}. ${match3[2].toUpperCase()}. ${match3[3].toUpperCase()}.`;
    }

    const match2 = trimmed.match(/^([А-Яа-яA-Za-z])[\.\s]+([А-Яа-яA-Za-z])[\.]?$/);
    if (match2) {
      return `${match2[1].toUpperCase()}. ${match2[2].toUpperCase()}.`;
    }

    const words = trimmed.split(/[\s\t\n]+/).filter(w => w.length > 0);
    if (words.length >= 3) {
      const f = words[0][0].toUpperCase();
      const i = words[1][0].toUpperCase();
      const o = words[2][0].toUpperCase();
      return `${f}. ${i}. ${o}.`;
    } else if (words.length === 2) {
      const f = words[0][0].toUpperCase();
      const i = words[1][0].toUpperCase();
      return `${f}. ${i}.`;
    } else if (words.length === 1 && words[0].length > 0) {
      return words[0][0].toUpperCase() + '.';
    }

    return trimmed;
  }

  function isDeadlinePassed(deadlineStr) {
    if (!deadlineStr) return false;
    return new Date(deadlineStr).getTime() < Date.now();
  }

  function formatShortDeadline(deadlineStr) {
    if (!deadlineStr) return 'Бессрочно';
    const d = new Date(deadlineStr);
    const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${month}, ${hours}:${mins}`;
  }

  function formatFullDeadline(deadlineStr) {
    if (!deadlineStr) return 'Бессрочно';
    const d = new Date(deadlineStr);
    return d.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getDeadlineTimeRemainingText(deadlineStr) {
    if (!deadlineStr) return { text: 'Бессрочно', isPassed: false };
    const deadline = new Date(deadlineStr).getTime();
    const now = Date.now();
    const diffMs = deadline - now;
    const isPassed = diffMs < 0;
    const absDiff = Math.abs(diffMs);

    const diffDays = Math.floor(absDiff / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((absDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (isPassed) {
      if (diffDays > 0) {
        return { text: `Дедлайн прошёл ${diffDays} дн. назад`, isPassed: true };
      }
      return { text: `Дедлайн прошёл ${diffHours} ч. назад`, isPassed: true };
    } else {
      if (diffDays > 0) {
        return { text: `Осталось: ${diffDays} дн. ${diffHours} ч.`, isPassed: false };
      }
      return { text: `Осталось: ${diffHours} ч.`, isPassed: false };
    }
  }

  async function computeHash(str, salt) {
    const encoder = new TextEncoder();
    const salted = encoder.encode(str + ':' + salt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', salted);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function extractLinks(text) {
    if (!text) return [];
    if (Array.isArray(text)) return text.filter(Boolean);
    const lines = String(text).split(/[\r\n,;]+/);
    const links = [];
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const match = trimmed.match(/https?:\/\/[^\s]+/) || (trimmed.startsWith('www.') ? ['https://' + trimmed] : null);
      if (match) {
        links.push(match[0]);
      } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        links.push(trimmed);
      }
    });
    return links;
  }

  function getLinkMeta(url) {
    const u = url.toLowerCase();
    if (u.includes('youtube.com') || u.includes('youtu.be') || u.includes('rutube.ru') || u.includes('vk.com/video') || u.includes('vimeo.com')) {
      return { icon: '🎬', label: 'Видеоматериал', bg: '#e11d48', border: '#e11d48' };
    }
    if (u.includes('github.com') || u.includes('gitlab.com')) {
      return { icon: '💻', label: 'Репозиторий GitHub', bg: '#24292f', border: '#24292f' };
    }
    if (u.includes('docs.google.com') || u.includes('drive.google.com')) {
      return { icon: '📄', label: 'Google Документ / Диск', bg: '#0284c7', border: '#0284c7' };
    }
    if (u.includes('habr.com') || u.includes('medium.com')) {
      return { icon: '📖', label: 'Статья / Гайд', bg: '#0284c7', border: '#0284c7' };
    }
    return { icon: '🔗', label: 'Открыть ссылку', bg: '#4f46e5', border: '#4f46e5' };
  }

  function extractImages(imgField) {
    if (!imgField) return [];
    if (Array.isArray(imgField)) return imgField.filter(Boolean);
    return [imgField].filter(Boolean);
  }

  function utf8ToBase64(str) {
    return window.btoa(unescape(encodeURIComponent(str)));
  }

  /**
   * Сжатие и масштабирование загруженных файлов картинок с помощью Canvas
   * (уменьшает тяжелые фото с 5-10 МБ до 80-120 КБ для экономии памяти и квоты)
   */
  function compressImageFile(file, maxWidth = 1280, maxHeight = 1280, quality = 0.82) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      // SVG и GIF (с анимацией) не пережимаем
      if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxWidth || height > maxHeight) {
            if (width / height > maxWidth / maxHeight) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          try {
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            resolve(dataUrl);
          } catch (err) {
            resolve(e.target.result);
          }
        };
        img.onerror = () => resolve(e.target.result);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /* ==========================================================================
     Надежное хранилище IndexedDB (без лимита 5 МБ в localStorage)
     ========================================================================== */
  const IDB_NAME = 'ClassRegisterDB';
  const IDB_STORE = 'app_data';

  function openIndexedDB() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function idbGet(key) {
    try {
      const db = await openIndexedDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function idbSet(key, value) {
    try {
      const db = await openIndexedDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  }

  async function idbDelete(key) {
    try {
      const db = await openIndexedDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  }

  return {
    formatToInitials,
    isDeadlinePassed,
    formatShortDeadline,
    formatFullDeadline,
    getDeadlineTimeRemainingText,
    computeHash,
    showToast,
    escapeHtml,
    extractLinks,
    getLinkMeta,
    extractImages,
    utf8ToBase64,
    compressImageFile,
    idbGet,
    idbSet,
    idbDelete
  };
})();
