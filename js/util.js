/* global window */
/* 通用工具：DOM、日期、颜色、图片压缩、提示条 */
(function () {
  'use strict';

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.keys(value).forEach((dataKey) => { node.dataset[dataKey] = value[dataKey]; });
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    (children || []).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    });
    return node;
  }

  function uid(prefix) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix || 'id'}_${Date.now().toString(36)}${rand}`;
  }

  /* ------------------------------- 日期 ------------------------------- */
  function pad2(n) { return String(n).padStart(2, '0'); }

  function toDateOnly(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function formatDateTime(iso) {
    const date = toDateOnly(iso);
    if (!date) return '';
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function formatDateShort(iso) {
    const date = toDateOnly(iso);
    if (!date) return '';
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function relativeDue(iso) {
    const date = toDateOnly(iso);
    if (!date) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDue = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const days = Math.round((startOfDue - startOfToday) / 86400000);
    if (days < 0) return { text: `已过期 ${Math.abs(days)} 天`, kind: 'overdue', days };
    if (days === 0) return { text: '今天截止', kind: 'due-soon', days };
    if (days === 1) return { text: '明天截止', kind: 'due-soon', days };
    if (days <= 3) return { text: `${days} 天后截止`, kind: 'due-soon', days };
    return { text: `还有 ${days} 天`, kind: '', days };
  }

  function toLocalInputValue(iso) {
    const date = toDateOnly(iso);
    if (!date) return '';
    const offset = date.getTimezoneOffset();
    const local = new Date(date.getTime() - offset * 60000);
    return local.toISOString().slice(0, 16);
  }

  function fromLocalInputValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
  }

  /** 本学期大概的当前周次：9 月 1 日附近开学，第 1 周从周一开始 */
  function guessCurrentWeek(semesterStart) {
    let start = toDateOnly(semesterStart);
    if (!start) {
      const now = new Date();
      const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
      start = new Date(year, 8, 1); // 9 月 1 日
    }
    // 对齐到那一周的周一
    const day = start.getDay() || 7;
    const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - (day - 1));
    const now = new Date();
    const diffDays = Math.floor((now - monday) / 86400000);
    if (diffDays < 0) return { week: 1, before: true };
    const week = Math.floor(diffDays / 7) + 1;
    return { week, before: false, after: week > 20 };
  }

  /* ------------------------------- 颜色 ------------------------------- */
  const PALETTE = [
    '#4361ee', '#e5484d', '#12a150', '#f0a02a', '#8b5cf6',
    '#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#64748b',
    '#a855f7', '#84cc16',
  ];

  function pickColor(index) {
    return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
  }

  function hexToRgba(hex, alpha) {
    const value = String(hex || '#4361ee').replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const num = parseInt(full, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function readableOn(hex) {
    const value = String(hex || '#4361ee').replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const num = parseInt(full, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62 ? '#16203a' : '#ffffff';
  }

  /* ------------------------------- 图片 ------------------------------- */
  /** 压缩图片：最长边不超过 maxSize，输出 JPEG，尽量把体积压到 300KB 以内 */
  function compressImage(file, maxSize) {
    const limit = maxSize || 1600;
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) {
        reject(new Error('不是图片文件'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片解析失败'));
        img.onload = () => {
          let quality = 0.82;
          let scale = Math.min(1, limit / Math.max(img.width, img.height));
          let dataUrl = '';
          for (let attempt = 0; attempt < 6; attempt += 1) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            dataUrl = canvas.toDataURL('image/jpeg', quality);
            const approxBytes = Math.round((dataUrl.length - 22) * 0.75);
            if (approxBytes <= 320 * 1024) break;
            if (quality > 0.5) quality -= 0.12;
            else scale *= 0.78;
          }
          resolve({ dataUrl, name: file.name || '图片' });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function bytesToText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  /* ------------------------------- 提示条 ----------------------------- */
  function toast(message, kind, ms) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const node = el('div', { class: `toast ${kind || ''}`, text: message });
    box.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s, transform .3s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(() => node.remove(), 320);
    }, ms || 2600);
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  window.U = {
    $, $$, el, uid, escapeHtml, debounce, clone,
    toDateOnly, formatDateTime, formatDateShort, relativeDue, toLocalInputValue, fromLocalInputValue,
    guessCurrentWeek, pad2,
    pickColor, hexToRgba, readableOn, PALETTE,
    compressImage, bytesToText,
    toast, WEEKDAYS,
  };
}());
