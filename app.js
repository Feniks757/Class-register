/**
 * Электронный журнал успеваемости — Основная логика
 */

(function () {
  'use strict';

  // Константы хранилища
  const STORAGE_KEY = 'class_register_data_v3';
  const ADMIN_SESSION_KEY = 'class_register_admin_active';
  const GITHUB_SETTINGS_KEY = 'class_register_github_settings';
  const STUDENT_UNLOCKED_GROUP_KEY = 'class_register_unlocked_group';

  // Состояние приложения
  let state = {
    data: null,
    currentGroupId: null,
    unlockedGroupId: null, // Группа, разблокированная студентом по ключу
    searchQuery: '',
    isAdmin: false,
    selectedAssignmentId: null,
    editingStudentId: null,
    editingAssignmentId: null,
    editingAssignmentImage: null,
    parsedImportData: null,
    githubSettings: {
      owner: '',
      repo: '',
      branch: 'main',
      token: ''
    }
  };

  /* ==========================================================================
     Утилиты для работы с именами (Ф. И. О.), датами и форматированием
     ========================================================================== */

  /**
   * Форматирует имя в инициалы вида "Ф. И. О." (например, "И. И. И." или "А. М. О.")
   */
  function formatToInitials(nameStr) {
    if (!nameStr) return '';
    const trimmed = nameStr.trim();

    // Если уже в формате трёх инициалов (напр. "И. И. И." или "И.И.И." или "И И И")
    const match3 = trimmed.match(/^([А-Яа-яA-Za-z])[\.\s]+([А-Яа-яA-Za-z])[\.\s]+([А-Яа-яA-Za-z])[\.]?$/);
    if (match3) {
      return `${match3[1].toUpperCase()}. ${match3[2].toUpperCase()}. ${match3[3].toUpperCase()}.`;
    }

    // Если строка из двух инициалов (напр. "И. И." или "И.И.")
    const match2 = trimmed.match(/^([А-Яа-яA-Za-z])[\.\s]+([А-Яа-яA-Za-z])[\.]?$/);
    if (match2) {
      return `${match2[1].toUpperCase()}. ${match2[2].toUpperCase()}.`;
    }

    // Если полное имя из слов ("Иванов Иван Иванович" -> "И. И. И.")
    const words = trimmed.split(/[\s\-]+/).filter(Boolean);
    if (words.length > 0) {
      return words.map(w => w[0].toUpperCase() + '.').join(' ');
    }
    return trimmed;
  }

  /**
   * Проверяет, просрочен ли дедлайн по сравнению с текущим моментом
   */
  function isDeadlinePassed(deadlineStr) {
    if (!deadlineStr) return false;
    const deadline = new Date(deadlineStr);
    return deadline.getTime() < Date.now();
  }

  /**
   * Форматирует дату для бейджей в заголовках колонок (напр., "до 15 окт.")
   */
  function formatShortDeadline(deadlineStr) {
    if (!deadlineStr) return 'Без срока';
    const d = new Date(deadlineStr);
    const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${month}, ${hours}:${mins}`;
  }

  /**
   * Форматирует полную дату и время для модального окна (напр., "15 октября 2026 г., 23:59")
   */
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

  /**
   * Вычисляет оставшееся или прошедшее время до дедлайна
   */
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

  /**
   * Вычисляет SHA-256 хеш строки с солью
   */
  async function computeHash(str, salt) {
    const encoder = new TextEncoder();
    const salted = encoder.encode(str + ':' + salt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', salted);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ==========================================================================
     Уведомления (Toast)
     ========================================================================== */
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

  /* ==========================================================================
     Загрузка и сохранение данных
     ========================================================================== */

  async function initData() {
    // Очистка устаревших ключей предыдущих версий для полного сброса
    localStorage.removeItem('class_register_data_v1');
    localStorage.removeItem('class_register_data_v2');

    // 1. Попытка загрузить из localStorage (для сессии редактирования)
    const local = localStorage.getItem(STORAGE_KEY);
    if (local) {
      try {
        state.data = JSON.parse(local);
      } catch (e) {
        console.warn('Ошибка парсинга localStorage:', e);
      }
    }

    // 2. Если данных нет, пробуем data.json или data.js
    if (!state.data) {
      try {
        const resp = await fetch('data.json');
        if (resp.ok) {
          state.data = await resp.json();
        }
      } catch (err) {
        console.log('fetch(data.json) не сработал (возможно локальный запуск file://), используем встроенные данные');
      }
    }

    // 3. Fallback на глобальный объект window.DEFAULT_REGISTER_DATA
    if (!state.data && window.DEFAULT_REGISTER_DATA) {
      state.data = JSON.parse(JSON.stringify(window.DEFAULT_REGISTER_DATA));
    }

    // Восстанавливаем сессию администратора, если была
    if (sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true') {
      state.isAdmin = true;
    }

    // Загружаем сохранённые настройки GitHub
    const savedGh = localStorage.getItem(GITHUB_SETTINGS_KEY);
    if (savedGh) {
      try {
        state.githubSettings = { ...state.githubSettings, ...JSON.parse(savedGh) };
      } catch (e) {
        console.warn('Ошибка загрузки настроек GitHub:', e);
      }
    }

    // Автоматическая нормализация данных (конвертация ФИО в формат инициалов Ф. И. О., установка ключей групп и типов заданий)
    if (state.data && state.data.groups) {
      state.data.groups.forEach(g => {
        if (!g.key) g.key = g.name;
        if (g.assignments) {
          g.assignments.forEach(a => {
            if (!a.type) {
              a.type = a.id && a.id.startsWith('cw-') ? 'classwork' : 'homework';
            }
          });
        }
        if (g.students) {
          g.students.forEach(s => {
            s.name = formatToInitials(s.name);
          });
        }
      });
    }

    // Восстанавливаем разблокированную студентом группу из sessionStorage
    state.unlockedGroupId = sessionStorage.getItem(STUDENT_UNLOCKED_GROUP_KEY) || null;
    if (state.unlockedGroupId && state.data && state.data.groups) {
      const exists = state.data.groups.some(g => g.id === state.unlockedGroupId);
      if (exists) {
        state.currentGroupId = state.unlockedGroupId;
      } else {
        state.unlockedGroupId = null;
        sessionStorage.removeItem(STUDENT_UNLOCKED_GROUP_KEY);
      }
    }

    // Устанавливаем текущую группу (если еще не выбрана)
    if (!state.currentGroupId && state.data && state.data.groups && state.data.groups.length > 0) {
      state.currentGroupId = state.data.groups[0].id;
    }

    renderApp();
  }

  function saveData(notify = true) {
    if (!state.data) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
      if (notify) {
        showToast('Изменения сохранены локально', 'success');
      }
    } catch (e) {
      console.error('Ошибка сохранения:', e);
      showToast('Ошибка сохранения данных', 'error');
    }
  }

  /* ==========================================================================
     Рендеринг интерфейса
     ========================================================================== */

  function renderApp() {
    renderGateState();
    renderAdminState();
    renderGroupPills();
    renderStatistics();
    renderTable();
  }

  function renderGateState() {
    const gateScreen = document.getElementById('student-gate-screen');
    const badgeWrap = document.getElementById('student-unlocked-badge-wrap');
    const groupNameEl = document.getElementById('student-unlocked-group-name');
    const mainWrapper = document.querySelector('.main-wrapper');
    const gateError = document.getElementById('gate-error-message');

    if (gateError) gateError.style.display = 'none';

    if (state.isAdmin) {
      // Преподаватель видит журнал и все группы без ввода ключа
      if (gateScreen) gateScreen.style.display = 'none';
      if (badgeWrap) badgeWrap.style.display = 'none';
      if (mainWrapper) mainWrapper.style.display = 'flex';
      return;
    }

    if (!state.unlockedGroupId) {
      // Студент ещё не ввёл ключ группы
      if (gateScreen) gateScreen.style.display = 'flex';
      if (badgeWrap) badgeWrap.style.display = 'none';
      if (mainWrapper) mainWrapper.style.display = 'none';
      const keyInput = document.getElementById('gate-key-input');
      if (keyInput) setTimeout(() => keyInput.focus(), 150);
    } else {
      // Студент ввёл ключ: ведомость его группы открыта
      if (gateScreen) gateScreen.style.display = 'none';
      if (mainWrapper) mainWrapper.style.display = 'flex';
      const curGroup = getCurrentGroup();
      if (badgeWrap && curGroup) {
        badgeWrap.style.display = 'inline-flex';
        if (groupNameEl) groupNameEl.textContent = curGroup.name;
      }
    }
  }

  function handleGateLogin(enteredKey) {
    if (!state.data || !state.data.groups) return false;
    const cleanKey = enteredKey.trim().toLowerCase();
    if (!cleanKey) return false;

    const matched = state.data.groups.find(g => {
      const gKey = (g.key || g.name || '').trim().toLowerCase();
      const gName = (g.name || '').trim().toLowerCase();
      return gKey === cleanKey || gName === cleanKey;
    });

    if (matched) {
      state.unlockedGroupId = matched.id;
      state.currentGroupId = matched.id;
      sessionStorage.setItem(STUDENT_UNLOCKED_GROUP_KEY, matched.id);
      renderApp();
      showToast(`Ведомость группы ${matched.name} открыта!`, 'success');
      return true;
    }
    return false;
  }

  function handleStudentSwitchGroup() {
    state.unlockedGroupId = null;
    sessionStorage.removeItem(STUDENT_UNLOCKED_GROUP_KEY);
    renderApp();
    showToast('Введите ключ другой группы для доступа', 'info');
  }

  function renderAdminState() {
    const adminBanner = document.getElementById('admin-banner');
    const adminToolbarSection = document.getElementById('admin-toolbar-section');
    const loginBtn = document.getElementById('btn-admin-login');
    const body = document.body;

    if (state.isAdmin) {
      body.classList.add('admin-mode-active');
      if (adminBanner) adminBanner.classList.add('active');
      if (adminToolbarSection) adminToolbarSection.classList.add('active');
      if (loginBtn) {
        loginBtn.innerHTML = '<span>🔒</span> Выйти из режима преподавателя';
        loginBtn.className = 'btn btn-outline-danger btn-sm';
      }
    } else {
      body.classList.remove('admin-mode-active');
      if (adminBanner) adminBanner.classList.remove('active');
      if (adminToolbarSection) adminToolbarSection.classList.remove('active');
      if (loginBtn) {
        loginBtn.innerHTML = '<span>🔑</span> Режим преподавателя';
        loginBtn.className = 'btn btn-secondary btn-sm';
      }
    }
  }

  function getCurrentGroup() {
    if (!state.data || !state.data.groups || state.data.groups.length === 0) return null;
    return state.data.groups.find(g => g.id === state.currentGroupId) || state.data.groups[0] || null;
  }

  function renderGroupPills() {
    const container = document.getElementById('group-pills-container');
    const groupSelectorWrap = document.querySelector('.group-selector-wrap');
    if (!container || !state.data || !state.data.groups) return;

    // Студент видит только свою открытую группу; переключение между группами доступно преподавателю
    if (groupSelectorWrap) {
      groupSelectorWrap.style.display = state.isAdmin ? 'flex' : 'none';
    }

    container.innerHTML = '';

    if (state.data.groups.length === 0) {
      if (state.isAdmin) {
        const btnCreate = document.createElement('button');
        btnCreate.type = 'button';
        btnCreate.className = 'group-pill';
        btnCreate.style.borderStyle = 'dashed';
        btnCreate.textContent = '➕ Создать первую группу';
        btnCreate.addEventListener('click', openGroupManagerModal);
        container.appendChild(btnCreate);
      }
      return;
    }

    state.data.groups.forEach(group => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `group-pill ${group.id === state.currentGroupId ? 'active' : ''}`;
      pill.textContent = group.name;
      pill.title = group.department ? `${group.department} (Ключ: ${group.key || group.name})` : `Ключ: ${group.key || group.name}`;
      pill.addEventListener('click', () => {
        state.currentGroupId = group.id;
        state.searchQuery = '';
        const searchInput = document.getElementById('student-search-input');
        if (searchInput) searchInput.value = '';
        renderApp();
      });
      container.appendChild(pill);
    });
  }

  function renderStatistics() {
    const group = getCurrentGroup();
    const studentCountEl = document.getElementById('stat-students-count');
    const assignmentsCountEl = document.getElementById('stat-assignments-count');
    const groupAvgEl = document.getElementById('stat-group-avg');
    const debtsCountEl = document.getElementById('stat-debts-count');

    if (!group) {
      if (studentCountEl) studentCountEl.textContent = '0';
      if (assignmentsCountEl) assignmentsCountEl.textContent = '0 ДЗ, 0 КР';
      if (groupAvgEl) groupAvgEl.textContent = '—';
      if (debtsCountEl) debtsCountEl.textContent = '0';
      return;
    }

    const totalStudents = group.students.length;
    const hwList = group.assignments.filter(a => a.type !== 'classwork');
    const cwList = group.assignments.filter(a => a.type === 'classwork');

    let totalHwSubmitted = 0;
    let totalHwExpected = hwList.length * totalStudents;
    let overdueDebtsCount = 0;

    group.students.forEach(student => {
      hwList.forEach(assign => {
        const val = student.grades[assign.id];
        if (val === 'submitted' || val === 'late' || val === 'сдано' || val === 'сдано с опозданием') {
          totalHwSubmitted++;
        } else if (val === 'not_submitted' || val === 'не сдано' || isDeadlinePassed(assign.deadline)) {
          overdueDebtsCount++;
        }
      });
    });

    const completionRate = totalHwExpected > 0 ? Math.round((totalHwSubmitted / totalHwExpected) * 100) + '%' : '—';

    if (studentCountEl) studentCountEl.textContent = totalStudents;
    if (assignmentsCountEl) assignmentsCountEl.textContent = `${hwList.length} ДЗ, ${cwList.length} КР`;
    if (groupAvgEl) groupAvgEl.textContent = completionRate;
    if (debtsCountEl) debtsCountEl.textContent = overdueDebtsCount;
  }

  function renderTable() {
    const tableHeaderRow = document.getElementById('table-header-row');
    const tableBody = document.getElementById('table-body');
    const emptyState = document.getElementById('table-empty-state');
    const group = getCurrentGroup();

    if (!tableHeaderRow || !tableBody) return;

    // Очистка
    tableHeaderRow.innerHTML = '';
    tableBody.innerHTML = '';

    if (!group) {
      if (emptyState) {
        emptyState.style.display = 'block';
        emptyState.innerHTML = `
          <div style="font-size:2.5rem; margin-bottom:0.5rem;">📁</div>
          <p style="font-size:1.1rem; font-weight:600; color:var(--text-main);">Нет созданных групп</p>
          <p style="font-size:0.875rem; color:var(--text-muted); margin-top:0.35rem;">
            ${state.isAdmin ? 'Создайте группу кнопкой «📁 Управление группами» или импортируйте список студентов из таблицы-файла.' : 'Группы ещё не добавлены преподавателем.'}
          </p>
        `;
      }
      return;
    }

    // Очистка
    tableHeaderRow.innerHTML = '';
    tableBody.innerHTML = '';

    // 1. Фильтрация студентов по поиску
    const query = state.searchQuery.trim().toLowerCase();
    const filteredStudents = group.students.filter(s => {
      if (!query) return true;
      return s.name.toLowerCase().includes(query);
    });

    // 2. Рендеринг колонок заголовка
    // Колонка №
    const thNum = document.createElement('th');
    thNum.className = 'col-num';
    thNum.textContent = '№';
    tableHeaderRow.appendChild(thNum);

    // Колонка "Ф. И. О. студента"
    const thStudent = document.createElement('th');
    thStudent.className = 'col-sticky-student';
    thStudent.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span>Ф. И. О. студента</span>
        <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">${filteredStudents.length} чел.</span>
      </div>
    `;
    tableHeaderRow.appendChild(thStudent);

    // Колонка "Сдано ДЗ"
    const thTotal = document.createElement('th');
    thTotal.className = 'col-total';
    thTotal.textContent = 'Сдано ДЗ';
    tableHeaderRow.appendChild(thTotal);

    // Колонки для каждого задания
    group.assignments.forEach((assign, index) => {
      const thAssign = document.createElement('th');
      thAssign.className = 'col-assignment-header';

      const isCw = assign.type === 'classwork';
      const typeBadge = isCw
        ? '<span class="assignment-type-tag cw">🏫 КР</span>'
        : '<span class="assignment-type-tag hw">🏠 ДЗ</span>';

      const isPassed = isDeadlinePassed(assign.deadline);
      const deadlineClass = isPassed ? 'passed' : 'upcoming';
      const deadlineShort = formatShortDeadline(assign.deadline);

      const hasImage = Boolean(assign.image);
      const hasVideo = Boolean(assign.videoUrl);

      thAssign.innerHTML = `
        <div class="assignment-header-inner">
          <div class="assignment-title-row">
            <span class="assignment-header-title" title="Нажмите, чтобы просмотреть описание">${escapeHtml(assign.title)}</span>
            <button class="info-btn" title="Подробнее о задании" data-assign-id="${assign.id}">
              ℹ️
            </button>
          </div>
          <div class="assignment-meta-row">
            ${typeBadge}
            <span class="deadline-tag ${deadlineClass}" title="Срок: ${formatFullDeadline(assign.deadline)}">
              ${isPassed ? '⏰ ' : '📅 '} ${deadlineShort}
            </span>
            ${hasImage ? '<span class="assignment-image-indicator" title="Прикреплена картинка/схема">🖼️ Картинка</span>' : ''}
            ${hasVideo ? '<span class="assignment-video-indicator" title="Прикреплено видео">🎬 Видео</span>' : ''}
          </div>
          <div class="assignment-admin-actions">
            <button class="btn btn-secondary btn-sm" style="padding: 2px 6px; font-size: 0.72rem;" data-edit-assign="${assign.id}">✎ Изм.</button>
            <button class="btn btn-outline-danger btn-sm" style="padding: 2px 6px; font-size: 0.72rem;" data-delete-assign="${assign.id}">🗑</button>
          </div>
        </div>
      `;

      // Клик по заголовку открывает модалку с описанием задания
      thAssign.addEventListener('click', (e) => {
        if (e.target.closest('[data-edit-assign]') || e.target.closest('[data-delete-assign]')) return;
        openAssignmentDetailModal(assign.id);
      });

      tableHeaderRow.appendChild(thAssign);
    });

    // 3. Рендеринг строк студентов
    if (filteredStudents.length === 0) {
      if (emptyState) emptyState.style.display = 'block';
      return;
    } else {
      if (emptyState) emptyState.style.display = 'none';
    }

    const hwList = group.assignments.filter(a => a.type !== 'classwork');

    filteredStudents.forEach((student, index) => {
      const tr = document.createElement('tr');
      tr.dataset.studentRowId = student.id;

      // Клик по строке для выделения строки студента (голубоватый фон)
      tr.addEventListener('click', (e) => {
        // Если клик был по интерактивным элементам (кнопки, селекты, инпуты) - не переключаем
        if (e.target.closest('button, select, input, textarea, a')) return;
        tr.classList.toggle('row-highlighted');
      });

      // Номер по порядку
      const tdNum = document.createElement('td');
      tdNum.className = 'col-num';
      tdNum.textContent = index + 1;
      tr.appendChild(tdNum);

      // Студент ФИО + кнопки администратора
      const tdStudent = document.createElement('td');
      tdStudent.className = 'col-sticky-student';
      tdStudent.innerHTML = `
        <div class="student-info-cell">
          <span class="student-name">${escapeHtml(student.name)}</span>
          <div class="student-admin-actions">
            <button class="btn btn-secondary btn-sm" style="padding: 2px 5px; font-size: 0.72rem;" data-edit-student="${student.id}" title="Редактировать ФИО">✎</button>
            <button class="btn btn-outline-danger btn-sm" style="padding: 2px 5px; font-size: 0.72rem;" data-delete-student="${student.id}" title="Удалить студента">🗑</button>
          </div>
        </div>
      `;
      tr.appendChild(tdStudent);

      // Подсчет сданных ДЗ и долгов для студента
      let studentHwDone = 0;
      let studentHwDebts = 0;
      hwList.forEach(a => {
        const v = student.grades[a.id];
        if (v === 'submitted' || v === 'late' || v === 'сдано' || v === 'сдано с опозданием') {
          studentHwDone++;
        } else if (v === 'not_submitted' || v === 'не сдано' || isDeadlinePassed(a.deadline)) {
          studentHwDebts++;
        }
      });

      const tdTotal = document.createElement('td');
      tdTotal.className = 'col-total';
      const debtNotice = studentHwDebts > 0 ? `<div style="font-size:0.7rem; color:var(--danger); font-weight:700; margin-top:2px;">${studentHwDebts} долг.</div>` : '';
      tdTotal.innerHTML = `<span class="total-score-badge">${studentHwDone} / ${hwList.length}</span>${debtNotice}`;
      tr.appendChild(tdTotal);

      // Ячейки заданий для студента
      group.assignments.forEach(assign => {
        const tdGrade = document.createElement('td');
        const val = student.grades[assign.id];
        const isCw = assign.type === 'classwork';
        const isPassed = isDeadlinePassed(assign.deadline);

        tdGrade.className = 'grade-cell';
        tdGrade.dataset.studentId = student.id;
        tdGrade.dataset.assignId = assign.id;

        if (isCw) {
          // КЛАССНАЯ РАБОТА: текстовая отметка
          if (val !== null && val !== undefined && String(val).trim() !== '') {
            tdGrade.classList.add('is-graded');
            tdGrade.innerHTML = `<span class="badge-cw-text" title="${escapeHtml(val)}">${escapeHtml(val)}</span>`;
          } else {
            tdGrade.classList.add('is-pending');
            tdGrade.innerHTML = `<span class="pending-dash">—</span>`;
          }
        } else {
          // ДОМАШНЕЕ ЗАДАНИЕ: сдано / не сдано / сдано с опозданием
          if (val === 'submitted' || val === 'сдано') {
            tdGrade.classList.add('is-graded');
            tdGrade.innerHTML = `<span class="badge-hw badge-hw-submitted">✓ Сдано</span>`;
          } else if (val === 'late' || val === 'сдано с опозданием') {
            tdGrade.classList.add('is-graded');
            tdGrade.innerHTML = `<span class="badge-hw badge-hw-late">⏰ Сдано с опозданием</span>`;
          } else if (val === 'not_submitted' || val === 'не сдано') {
            tdGrade.classList.add('is-overdue');
            tdGrade.innerHTML = `<span class="badge-hw badge-hw-not-submitted">⚠️ Не сдано</span>`;
          } else {
            // Не выставлено
            if (isPassed) {
              tdGrade.classList.add('is-overdue');
              tdGrade.innerHTML = `<span class="badge-hw badge-hw-not-submitted" title="Дедлайн истёк! Работа не сдана.">⚠️ Не сдано</span>`;
            } else {
              tdGrade.classList.add('is-pending');
              tdGrade.innerHTML = `<span class="pending-dash" title="Ожидает сдачи">—</span>`;
            }
          }
        }

        // Если в режиме администратора — редактирование по клику на ячейку
        tdGrade.addEventListener('click', () => {
          if (state.isAdmin) {
            if (isCw) {
              startInlineClassworkEdit(tdGrade, student.id, assign.id, val);
            } else {
              startInlineHomeworkEdit(tdGrade, student.id, assign.id, val);
            }
          }
        });

        tr.appendChild(tdGrade);
      });

      tableBody.appendChild(tr);
    });

    // Навешиваем слушатели на действия администратора
    attachTableAdminListeners();
  }

  /* ==========================================================================
     Редактирование отметок в таблице (Inline)
     ========================================================================== */

  function startInlineHomeworkEdit(cell, studentId, assignId, currentVal) {
    if (cell.querySelector('.inline-hw-select')) return;

    const originalHTML = cell.innerHTML;
    const select = document.createElement('select');
    select.className = 'inline-hw-select';

    const normVal = (currentVal === 'сдано' ? 'submitted' : (currentVal === 'сдано с опозданием' ? 'late' : (currentVal === 'не сдано' ? 'not_submitted' : currentVal)));

    select.innerHTML = `
      <option value="submitted" ${normVal === 'submitted' ? 'selected' : ''}>✓ Сдано</option>
      <option value="late" ${normVal === 'late' ? 'selected' : ''}>⏰ Сдано с опозданием</option>
      <option value="not_submitted" ${normVal === 'not_submitted' ? 'selected' : ''}>⚠️ Не сдано</option>
      <option value="" ${!normVal ? 'selected' : ''}>— В ожидании (сброс)</option>
    `;

    cell.innerHTML = '';
    cell.appendChild(select);
    select.focus();

    let committed = false;
    const commitChange = () => {
      if (committed) return;
      committed = true;

      const chosen = select.value || null;
      const group = getCurrentGroup();
      if (!group) return;
      const student = group.students.find(s => s.id === studentId);
      if (!student) return;

      student.grades[assignId] = chosen;
      saveData(false);
      renderStatistics();
      renderTable();
    };

    select.addEventListener('change', commitChange);
    select.addEventListener('blur', commitChange);
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitChange();
      if (e.key === 'Escape') {
        committed = true;
        cell.innerHTML = originalHTML;
      }
    });
  }

  function startInlineClassworkEdit(cell, studentId, assignId, currentVal) {
    if (cell.querySelector('.inline-cw-input')) return;

    const originalHTML = cell.innerHTML;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-cw-input';
    input.value = (currentVal !== null && currentVal !== undefined) ? currentVal : '';
    input.placeholder = 'Отметка / текст...';

    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    const commitChange = () => {
      if (committed) return;
      committed = true;

      const rawVal = input.value.trim();
      const group = getCurrentGroup();
      if (!group) return;
      const student = group.students.find(s => s.id === studentId);
      if (!student) return;

      student.grades[assignId] = rawVal === '' ? null : rawVal;
      saveData(false);
      renderStatistics();
      renderTable();
    };

    input.addEventListener('blur', commitChange);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitChange();
      if (e.key === 'Escape') {
        committed = true;
        cell.innerHTML = originalHTML;
      }
    });
  }

  /* ==========================================================================
     Модальные окна
     ========================================================================== */

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
    }
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Клик вне карточки модалки закрывает её
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
      }
    });
  });

  // Кнопки крестика
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-overlay');
      if (modal) modal.classList.remove('active');
    });
  });

  /* ==========================================================================
     Модалка с подробным описанием задания
     ========================================================================== */

  function openAssignmentDetailModal(assignId) {
    const group = getCurrentGroup();
    if (!group) return;

    const assign = group.assignments.find(a => a.id === assignId);
    if (!assign) return;

    state.selectedAssignmentId = assignId;

    const titleEl = document.getElementById('modal-assign-detail-title');
    const groupBadgeEl = document.getElementById('modal-assign-detail-group');
    const deadlineBadgeEl = document.getElementById('modal-assign-detail-deadline');
    const statusBadgeEl = document.getElementById('modal-assign-detail-status');
    const typeBadgeEl = document.getElementById('modal-assign-detail-type');
    const descEl = document.getElementById('modal-assign-detail-desc');
    const statPassedEl = document.getElementById('modal-assign-stat-passed');
    const statDebtsEl = document.getElementById('modal-assign-stat-debts');
    const editBtn = document.getElementById('modal-assign-btn-edit');

    const isCw = assign.type === 'classwork';

    if (titleEl) titleEl.textContent = assign.title;
    if (groupBadgeEl) groupBadgeEl.textContent = `Группа: ${group.name}`;
    if (typeBadgeEl) {
      typeBadgeEl.textContent = isCw ? '🏫 Классная работа' : '🏠 Домашнее задание';
      typeBadgeEl.style.background = isCw ? '#fef3c7' : '#e0e7ff';
      typeBadgeEl.style.color = isCw ? '#92400e' : '#3730a3';
    }
    if (deadlineBadgeEl) deadlineBadgeEl.textContent = `Дедлайн: ${formatFullDeadline(assign.deadline)}`;

    const remaining = getDeadlineTimeRemainingText(assign.deadline);
    if (statusBadgeEl) {
      statusBadgeEl.textContent = remaining.text;
      statusBadgeEl.style.backgroundColor = remaining.isPassed ? 'var(--danger-bg)' : 'var(--primary-light)';
      statusBadgeEl.style.color = remaining.isPassed ? 'var(--danger-text)' : 'var(--primary)';
      statusBadgeEl.style.border = remaining.isPassed ? '1px solid var(--danger-border)' : '1px solid var(--primary-border)';
    }

    if (descEl) {
      descEl.textContent = assign.description || 'Описание задания отсутствует.';
    }

    // Отображение прикрепленного изображения
    const imageBox = document.getElementById('modal-assign-detail-image-box');
    const imageEl = document.getElementById('modal-assign-detail-image');
    if (imageBox && imageEl) {
      if (assign.image) {
        imageBox.style.display = 'block';
        imageEl.src = assign.image;
        imageEl.onclick = () => window.open(assign.image, '_blank');
      } else {
        imageBox.style.display = 'none';
        imageEl.src = '';
      }
    }

    // Отображение ссылки на видеоматериал
    const videoBox = document.getElementById('modal-assign-detail-video-box');
    const videoLink = document.getElementById('modal-assign-detail-video-link');
    if (videoBox && videoLink) {
      if (assign.videoUrl) {
        videoBox.style.display = 'block';
        videoLink.href = assign.videoUrl;
      } else {
        videoBox.style.display = 'none';
        videoLink.href = '#';
      }
    }

    // Подсчет статистики выполнения задания в группе
    if (isCw) {
      let markedCount = 0;
      group.students.forEach(s => {
        const val = s.grades[assign.id];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          markedCount++;
        }
      });
      if (statPassedEl) statPassedEl.textContent = `${markedCount} из ${group.students.length}`;
      if (statDebtsEl) statDebtsEl.textContent = `${group.students.length - markedCount} без отметки`;
    } else {
      let passedCount = 0;
      let debtCount = 0;
      group.students.forEach(s => {
        const val = s.grades[assign.id];
        if (val === 'submitted' || val === 'late' || val === 'сдано' || val === 'сдано с опозданием') {
          passedCount++;
        } else if (val === 'not_submitted' || val === 'не сдано' || remaining.isPassed) {
          debtCount++;
        }
      });
      if (statPassedEl) statPassedEl.textContent = `${passedCount} из ${group.students.length}`;
      if (statDebtsEl) statDebtsEl.textContent = debtCount;
    }

    // Кнопка редактирования задания из модалки для админа
    if (editBtn) {
      editBtn.style.display = state.isAdmin ? 'inline-flex' : 'none';
      editBtn.onclick = () => {
        closeModal('modal-assignment-detail');
        openEditAssignmentModal(assign.id);
      };
    }

    openModal('modal-assignment-detail');
  }

  /* ==========================================================================
     Авторизация администратора (Режим преподавателя)
     ========================================================================== */

  function handleAdminToggle() {
    if (state.isAdmin) {
      // Выход из режима админа
      state.isAdmin = false;
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      renderApp();
      showToast('Вы вышли из режима преподавателя', 'info');
    } else {
      // Открываем модалку входа
      const passInput = document.getElementById('admin-password-input');
      const errorMsg = document.getElementById('admin-login-error');
      if (passInput) passInput.value = '';
      if (errorMsg) errorMsg.style.display = 'none';
      openModal('modal-admin-login');
      setTimeout(() => passInput && passInput.focus(), 150);
    }
  }

  async function checkAdminPassword(enteredPassword) {
    if (!state.data || !state.data.settings) return false;
    const salt = state.data.settings.salt || 'class_register_salt_v1';
    const computed = await computeHash(enteredPassword, salt);
    return computed === state.data.settings.adminPasswordHash;
  }

  document.getElementById('form-admin-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const passInput = document.getElementById('admin-password-input');
    const errorMsg = document.getElementById('admin-login-error');
    const entered = passInput ? passInput.value : '';

    const isValid = await checkAdminPassword(entered);
    if (isValid) {
      state.isAdmin = true;
      sessionStorage.setItem(ADMIN_SESSION_KEY, 'true');
      closeModal('modal-admin-login');
      renderApp();
      showToast('Режим преподавателя включен! Теперь вы можете изменять оценки и задания.', 'success');
    } else {
      if (errorMsg) {
        errorMsg.style.display = 'block';
        errorMsg.textContent = 'Неверный пароль. Попробуйте снова.';
      }
    }
  });

  /* ==========================================================================
     Управление заданиями (Создание / Редактирование / Удаление)
     ========================================================================== */

  function updateImageEditorPreview() {
    const previewWrap = document.getElementById('assign-image-preview-wrap');
    const previewImg = document.getElementById('assign-image-preview');
    const urlInput = document.getElementById('assign-image-url');

    if (state.editingAssignmentImage) {
      if (previewWrap) previewWrap.style.display = 'flex';
      if (previewImg) previewImg.src = state.editingAssignmentImage;
      if (urlInput && state.editingAssignmentImage.startsWith('http')) {
        urlInput.value = state.editingAssignmentImage;
      }
    } else {
      if (previewWrap) previewWrap.style.display = 'none';
      if (previewImg) previewImg.src = '';
      if (urlInput) urlInput.value = '';
    }
  }

  function openEditAssignmentModal(assignId = null) {
    state.editingAssignmentId = assignId;
    const group = getCurrentGroup();
    if (!group) {
      showToast('Сначала создайте хотя бы одну группу', 'warning');
      openGroupManagerModal();
      return;
    }

    const modalTitle = document.getElementById('modal-assign-editor-title');
    const typeSelect = document.getElementById('assign-type-select');
    const titleInput = document.getElementById('assign-title-input');
    const descInput = document.getElementById('assign-desc-input');
    const deadlineInput = document.getElementById('assign-deadline-input');
    const videoInput = document.getElementById('assign-video-input');
    const fileInput = document.getElementById('assign-image-file');

    if (fileInput) fileInput.value = '';

    if (assignId) {
      const assign = group.assignments.find(a => a.id === assignId);
      if (!assign) return;
      if (modalTitle) modalTitle.textContent = 'Редактировать задание';
      if (typeSelect) typeSelect.value = assign.type || 'homework';
      if (titleInput) titleInput.value = assign.title;
      if (descInput) descInput.value = assign.description;
      if (videoInput) videoInput.value = assign.videoUrl || '';
      state.editingAssignmentImage = assign.image || null;
      if (deadlineInput) {
        // Преобразуем формат в YYYY-MM-DDTHH:mm
        const d = new Date(assign.deadline);
        const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        deadlineInput.value = iso;
      }
    } else {
      if (modalTitle) modalTitle.textContent = 'Добавить новое задание';
      if (typeSelect) typeSelect.value = 'homework';
      if (titleInput) titleInput.value = '';
      if (descInput) descInput.value = '';
      if (videoInput) videoInput.value = '';
      state.editingAssignmentImage = null;
      if (deadlineInput) {
        // Дедлайн по умолчанию через 7 дней
        const d = new Date();
        d.setDate(d.getDate() + 7);
        d.setHours(23, 59, 0, 0);
        const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        deadlineInput.value = iso;
      }
    }

    updateImageEditorPreview();
    openModal('modal-assignment-editor');
  }

  document.getElementById('form-assignment-editor')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const group = getCurrentGroup();
    if (!group) return;

    const type = document.getElementById('assign-type-select')?.value || 'homework';
    const title = document.getElementById('assign-title-input').value.trim();
    const description = document.getElementById('assign-desc-input').value.trim();
    const deadlineVal = document.getElementById('assign-deadline-input').value;
    const videoUrl = document.getElementById('assign-video-input')?.value.trim() || null;
    const image = state.editingAssignmentImage || null;

    if (!title) {
      showToast('Укажите название задания', 'error');
      return;
    }

    const deadline = deadlineVal ? new Date(deadlineVal).toISOString() : new Date().toISOString();

    if (state.editingAssignmentId) {
      // Редактирование
      const assign = group.assignments.find(a => a.id === state.editingAssignmentId);
      if (assign) {
        assign.type = type;
        assign.title = title;
        assign.description = description;
        assign.deadline = deadline;
        assign.videoUrl = videoUrl;
        assign.image = image;
        showToast('Задание успешно обновлено', 'success');
      }
    } else {
      // Создание
      const newId = (type === 'classwork' ? 'cw-' : 'hw-') + Date.now();
      group.assignments.push({
        id: newId,
        type,
        title,
        description,
        deadline,
        videoUrl,
        image,
      });

      // Инициализируем оценки студентов как null
      group.students.forEach(s => {
        s.grades[newId] = null;
      });

      showToast('Новое задание добавлено', 'success');
    }

    saveData();
    closeModal('modal-assignment-editor');
    renderApp();
  });

  function deleteAssignment(assignId) {
    const group = getCurrentGroup();
    if (!group) return;

    const assign = group.assignments.find(a => a.id === assignId);
    if (!assign) return;

    if (!confirm(`Вы действительно хотите удалить задание "${assign.title}"?\nВсе выставленные баллы за него будут удалены.`)) {
      return;
    }

    group.assignments = group.assignments.filter(a => a.id !== assignId);
    group.students.forEach(s => {
      delete s.grades[assignId];
    });

    saveData();
    renderApp();
    showToast(`Задание "${assign.title}" удалено`, 'info');
  }

  /* ==========================================================================
     Управление студентами (Добавление / Редактирование / Удаление)
     ========================================================================== */

  function openStudentModal(studentId = null) {
    state.editingStudentId = studentId;
    const group = getCurrentGroup();
    if (!group) {
      showToast('Сначала создайте хотя бы одну группу', 'warning');
      openGroupManagerModal();
      return;
    }

    const modalTitle = document.getElementById('modal-student-title');
    const nameInput = document.getElementById('student-name-input');

    if (studentId) {
      const student = group.students.find(s => s.id === studentId);
      if (!student) return;
      if (modalTitle) modalTitle.textContent = 'Редактировать студента';
      if (nameInput) nameInput.value = student.name;
    } else {
      if (modalTitle) modalTitle.textContent = 'Добавить студента в группу ' + group.name;
      if (nameInput) nameInput.value = '';
    }

    openModal('modal-student');
    setTimeout(() => nameInput && nameInput.focus(), 150);
  }

  document.getElementById('form-student')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const group = getCurrentGroup();
    if (!group) return;

    const rawName = document.getElementById('student-name-input').value.trim();
    if (!rawName) {
      showToast('Введите ФИО студента', 'error');
      return;
    }

    const formattedName = formatToInitials(rawName);

    if (state.editingStudentId) {
      const student = group.students.find(s => s.id === state.editingStudentId);
      if (student) {
        student.name = formattedName;
        showToast('Данные студента обновлены', 'success');
      }
    } else {
      const newStudent = {
        id: 's-' + Date.now(),
        name: formattedName,
        grades: {},
      };
      group.assignments.forEach(a => {
        newStudent.grades[a.id] = null;
      });
      group.students.push(newStudent);
      // Сортируем студентов по алфавиту
      group.students.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      showToast(`Студент ${formattedName} добавлен`, 'success');
    }

    saveData();
    closeModal('modal-student');
    renderApp();
  });

  function deleteStudent(studentId) {
    const group = getCurrentGroup();
    if (!group) return;

    const student = group.students.find(s => s.id === studentId);
    if (!student) return;

    if (!confirm(`Удалить студента "${student.name}" из группы ${group.name}?`)) {
      return;
    }

    group.students = group.students.filter(s => s.id !== studentId);
    saveData();
    renderApp();
    showToast(`Студент "${student.name}" удалён`, 'info');
  }

  /* ==========================================================================
     Управление группами (Создание / Переименование / Удаление)
     ========================================================================== */

  function openGroupManagerModal() {
    renderGroupManagerList();
    openModal('modal-group-manager');
  }

  function renderGroupManagerList() {
    const listEl = document.getElementById('group-manager-list');
    if (!listEl || !state.data || !state.data.groups) return;

    listEl.innerHTML = '';

    if (state.data.groups.length === 0) {
      listEl.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-muted); font-size:0.875rem;">Нет созданных групп. Создайте группу с помощью формы ниже или выполните импорт из файла.</div>';
      return;
    }

    state.data.groups.forEach(g => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:0.6rem; border-bottom:1px solid var(--border-color);';
      const keyVal = g.key || g.name;
      item.innerHTML = `
        <div>
          <strong>${escapeHtml(g.name)}</strong>
          <span style="font-size:0.75rem; background:var(--primary-light); color:var(--primary); padding:2px 6px; border-radius:4px; margin-left:0.4rem; font-weight:600;">
            Ключ: ${escapeHtml(keyVal)}
          </span>
          <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${g.students.length} студ., ${g.assignments.length} зад. ${g.department ? '• ' + escapeHtml(g.department) : ''}</div>
        </div>
        <div style="display:flex; gap:0.4rem;">
          <button class="btn btn-outline-danger btn-sm" data-delete-group="${g.id}">Удалить</button>
        </div>
      `;
      listEl.appendChild(item);
    });

    listEl.querySelectorAll('[data-delete-group]').forEach(btn => {
      btn.addEventListener('click', () => {
        const gid = btn.dataset.deleteGroup;
        if (confirm('Вы уверены, что хотите удалить группу со всеми студентами и оценками?')) {
          state.data.groups = state.data.groups.filter(g => g.id !== gid);
          if (state.currentGroupId === gid) {
            state.currentGroupId = state.data.groups.length > 0 ? state.data.groups[0].id : null;
          }
          saveData();
          renderGroupManagerList();
          renderApp();
          showToast('Группа удалена', 'info');
        }
      });
    });
  }

  document.getElementById('form-add-group')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('new-group-name');
    const keyInput = document.getElementById('new-group-key');
    const deptInput = document.getElementById('new-group-dept');
    const name = nameInput ? nameInput.value.trim() : '';
    const key = keyInput && keyInput.value.trim() ? keyInput.value.trim() : name;
    const dept = deptInput ? deptInput.value.trim() : '';

    if (!name) {
      showToast('Укажите название группы', 'error');
      return;
    }

    const newGroup = {
      id: 'grp-' + Date.now(),
      name,
      key, // Ключ для доступа студентов к группе
      department: dept,
      assignments: [],
      students: [],
    };

    state.data.groups.push(newGroup);
    state.currentGroupId = newGroup.id;
    saveData();

    if (nameInput) nameInput.value = '';
    if (keyInput) keyInput.value = '';
    if (deptInput) deptInput.value = '';

    renderGroupManagerList();
    renderApp();
    showToast(`Группа ${name} добавлена (ключ доступа: ${key})`, 'success');
  });

  /* ==========================================================================
     Смена пароля администратора
     ========================================================================== */

  document.getElementById('form-change-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPass = document.getElementById('current-password-input').value;
    const newPass = document.getElementById('new-password-input').value;
    const confirmPass = document.getElementById('confirm-password-input').value;
    const errorEl = document.getElementById('change-password-error');

    if (errorEl) errorEl.style.display = 'none';

    const isValidCurrent = await checkAdminPassword(currentPass);
    if (!isValidCurrent) {
      if (errorEl) {
        errorEl.textContent = 'Текущий пароль указан неверно';
        errorEl.style.display = 'block';
      }
      return;
    }

    if (newPass.length < 4) {
      if (errorEl) {
        errorEl.textContent = 'Новый пароль должен содержать минимум 4 символа';
        errorEl.style.display = 'block';
      }
      return;
    }

    if (newPass !== confirmPass) {
      if (errorEl) {
        errorEl.textContent = 'Новые пароли не совпадают';
        errorEl.style.display = 'block';
      }
      return;
    }

    const salt = state.data.settings.salt || 'class_register_salt_v1';
    state.data.settings.adminPasswordHash = await computeHash(newPass, salt);
    saveData();
    closeModal('modal-change-password');
    showToast('Пароль администратора успешно изменён!', 'success');
  });

  /* ==========================================================================
     Экспорт / Скачивание данных для GitHub Pages
     ========================================================================== */

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function exportDataJson() {
    if (!state.data) return;
    const jsonStr = JSON.stringify(state.data, null, 2);
    downloadFile(jsonStr, 'data.json', 'application/json');
    showToast('Файл data.json скачан!', 'success');
  }

  function exportDataJs() {
    if (!state.data) return;
    const jsContent = `/**
 * Автоматически сгенерированные данные электронного журнала
 * Экспортировано: ${new Date().toISOString()}
 */
window.DEFAULT_REGISTER_DATA = ${JSON.stringify(state.data, null, 2)};
`;
    downloadFile(jsContent, 'data.js', 'text/javascript');
    showToast('Файл data.js скачан!', 'success');
  }

  function openExportModal() {
    const textarea = document.getElementById('export-json-preview');
    if (textarea && state.data) {
      textarea.value = JSON.stringify(state.data, null, 2);
    }
    openModal('modal-export-data');
  }

  /* ==========================================================================
     Импорт списка студентов из файлов-таблиц (HTML, CSV, TSV, TXT)
     ========================================================================== */

  function parseStudentsFromHTML(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    // 1. Попытка определить название группы из заголовков (напр., "Список группы P3465 на 15.11.2026")
    let detectedGroupName = '';
    const fullText = doc.body.textContent || '';
    const groupMatch = fullText.match(/Список группы\s+([A-Za-zА-Яа-я0-9\-_]+)/i) ||
                       fullText.match(/Группа[:\s]+([A-Za-zА-Яа-я0-9\-_]+)/i);
    if (groupMatch) {
      detectedGroupName = groupMatch[1].trim();
    }

    const students = [];
    const tables = doc.querySelectorAll('table');

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length === 0) continue;

      let nameColIndex = -1;

      // Проверяем первые 3 строки на наличие заголовка с Ф.И.О.
      for (let r = 0; r < Math.min(rows.length, 3); r++) {
        const cells = Array.from(rows[r].querySelectorAll('th, td'));
        cells.forEach((cell, idx) => {
          const txt = cell.textContent.trim().toLowerCase();
          if (txt.includes('ф.и.о') || txt.includes('фио') || txt.includes('фамилия') || txt.includes('студент') || txt.includes('имя')) {
            nameColIndex = idx;
          }
        });
        if (nameColIndex !== -1) break;
      }

      // Если явного заголовка нет, ищем колонку с ФИО эвристически
      if (nameColIndex === -1 && rows.length > 1) {
        const colScores = {};
        rows.slice(0, 15).forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          cells.forEach((cell, idx) => {
            const txt = cell.textContent.trim();
            // Паттерн ФИО (хотя бы 2 слова на русском с заглавной буквы)
            if (/^[А-ЯЁ][а-яё\-]+(\s+[А-ЯЁ][а-яё\-]+)+/.test(txt)) {
              colScores[idx] = (colScores[idx] || 0) + 1;
            }
          });
        });
        let maxScore = 0;
        for (const idx in colScores) {
          if (colScores[idx] > maxScore) {
            maxScore = colScores[idx];
            nameColIndex = Number(idx);
          }
        }
      }

      // Если определили колонку, извлекаем студентов
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (nameColIndex !== -1 && cells[nameColIndex]) {
          let name = cells[nameColIndex].textContent.trim();
          name = name.replace(/\s+/g, ' ');
          if (name && !name.toLowerCase().includes('ф.и.о') && !name.toLowerCase().includes('фио') && name.length >= 3) {
            if (/[А-Яа-яЁё]/.test(name)) {
              // Сохраняем в формате Ф. И. О. (например, "И. И. И." или "А. М. О.")
              const initials = formatToInitials(name);
              if (!students.includes(initials)) {
                students.push(initials);
              }
            }
          }
        }
      });

      if (students.length > 0) break;
    }

    return { groupName: detectedGroupName, students };
  }

  function parseStudentsFromText(text) {
    let detectedGroupName = '';
    const groupMatch = text.match(/Список группы\s+([A-Za-zА-Яа-я0-9\-_]+)/i) ||
                       text.match(/Группа[:\s]+([A-Za-zА-Яа-я0-9\-_]+)/i);
    if (groupMatch) {
      detectedGroupName = groupMatch[1].trim();
    }

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const students = [];

    lines.forEach(line => {
      if (line.toLowerCase().includes('ф.и.о') || line.toLowerCase().includes('фио')) return;

      let candidate = '';
      const parts = line.split(/[;\t,]/).map(p => p.trim());
      if (parts.length > 1) {
        const namePart = parts.find(p => /^[А-ЯЁа-яё\s\-]{4,}$/.test(p) && p.split(' ').length >= 2);
        candidate = namePart || parts[parts.length - 1];
      } else {
        candidate = line.replace(/^\d+[\.\)\s\t]+/, '').replace(/^\d{5,}\s+/, '').trim();
      }

      if (candidate && /[А-Яа-яЁё]/.test(candidate) && candidate.length >= 3) {
        candidate = candidate.replace(/\s+/g, ' ');
        const initials = formatToInitials(candidate);
        if (!students.includes(initials)) {
          students.push(initials);
        }
      }
    });

    return { groupName: detectedGroupName, students };
  }

  function parseFileContent(content) {
    if (content.includes('<table') || content.includes('<!DOCTYPE') || content.includes('<html')) {
      return parseStudentsFromHTML(content);
    }
    return parseStudentsFromText(content);
  }

  function openImportModal() {
    state.parsedImportData = null;
    const previewContainer = document.getElementById('import-preview-container');
    const previewTbody = document.getElementById('import-preview-tbody');
    const countBadge = document.getElementById('import-count-badge');
    const confirmBtn = document.getElementById('btn-confirm-import');
    const rawTextarea = document.getElementById('import-raw-textarea');
    const autoGroupHint = document.getElementById('import-auto-group-hint');
    const fileInput = document.getElementById('import-file-input');
    const newGroupNameInput = document.getElementById('import-new-group-name');

    if (fileInput) fileInput.value = '';
    if (rawTextarea) rawTextarea.value = '';
    if (newGroupNameInput) newGroupNameInput.value = '';
    if (previewContainer) previewContainer.style.display = 'none';
    if (previewTbody) previewTbody.innerHTML = '';
    if (countBadge) countBadge.textContent = '0';
    if (confirmBtn) confirmBtn.disabled = true;
    if (autoGroupHint) autoGroupHint.style.display = 'none';

    updateImportGroupSelect();
    openModal('modal-import-students');
  }

  function toggleNewGroupBox() {
    const select = document.getElementById('import-target-group-select');
    const newGroupBox = document.getElementById('import-new-group-box');
    if (!select || !newGroupBox) return;
    newGroupBox.style.display = select.value === '__new__' ? 'block' : 'none';
  }

  function updateImportGroupSelect(detectedName = '') {
    const select = document.getElementById('import-target-group-select');
    const newGroupNameInput = document.getElementById('import-new-group-name');
    if (!select || !state.data || !state.data.groups) return;

    select.innerHTML = '';

    const defaultNewName = detectedName || (state.data.groups.length > 0 ? ('Группа ' + (state.data.groups.length + 1)) : 'ИТ-21');
    const optNew = document.createElement('option');
    optNew.value = '__new__';
    optNew.textContent = `➕ Создать новую группу`;
    select.appendChild(optNew);

    state.data.groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `В группу: ${g.name} (${g.students.length} студ.)`;
      if (detectedName && g.name.toLowerCase() === detectedName.toLowerCase()) {
        opt.selected = true;
      } else if (!detectedName && g.id === state.currentGroupId) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    if (detectedName && !state.data.groups.some(g => g.name.toLowerCase() === detectedName.toLowerCase())) {
      optNew.selected = true;
    }

    if (newGroupNameInput && (!newGroupNameInput.value || detectedName)) {
      newGroupNameInput.value = defaultNewName;
    }

    toggleNewGroupBox();
  }

  function renderImportPreview(result) {
    state.parsedImportData = result;
    const previewContainer = document.getElementById('import-preview-container');
    const previewTbody = document.getElementById('import-preview-tbody');
    const countBadge = document.getElementById('import-count-badge');
    const confirmBtn = document.getElementById('btn-confirm-import');
    const autoGroupHint = document.getElementById('import-auto-group-hint');

    if (!result || !result.students || result.students.length === 0) {
      showToast('Не удалось распознать студентов в файле. Проверьте формат.', 'error');
      if (previewContainer) previewContainer.style.display = 'none';
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    updateImportGroupSelect(result.groupName);

    if (result.groupName && autoGroupHint) {
      autoGroupHint.style.display = 'block';
      autoGroupHint.innerHTML = `💡 В файле обнаружено название группы: <b>${escapeHtml(result.groupName)}</b>`;
    }

    if (countBadge) countBadge.textContent = result.students.length;
    if (previewTbody) {
      previewTbody.innerHTML = '';
      result.students.forEach((name, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td><b>${escapeHtml(name)}</b></td>
          <td><span style="color:var(--success); font-weight:600;">✓ Готов</span></td>
        `;
        previewTbody.appendChild(tr);
      });
    }

    if (previewContainer) previewContainer.style.display = 'block';
    if (confirmBtn) confirmBtn.disabled = false;
    showToast(`Успешно распознано: ${result.students.length} студентов!`, 'success');
  }

  function confirmImport() {
    if (!state.parsedImportData || !state.parsedImportData.students || state.parsedImportData.students.length === 0) {
      return;
    }

    const select = document.getElementById('import-target-group-select');
    const targetValue = select ? select.value : '__new__';
    let targetGroup = null;

    if (targetValue === '__new__') {
      const customNameInput = document.getElementById('import-new-group-name');
      const rawCustomName = customNameInput ? customNameInput.value.trim() : '';
      const groupName = rawCustomName || state.parsedImportData.groupName || ('Группа ' + (state.data.groups.length + 1));
      targetGroup = {
        id: 'grp-' + Date.now(),
        name: groupName,
        key: groupName, // Ключ доступа для студентов по умолчанию равен номеру группы
        department: '',
        assignments: [],
        students: [],
      };
      state.data.groups.push(targetGroup);
    } else {
      targetGroup = state.data.groups.find(g => g.id === targetValue);
    }

    if (!targetGroup) return;

    let addedCount = 0;
    state.parsedImportData.students.forEach(name => {
      if (!targetGroup.students.some(s => s.name.toLowerCase() === name.toLowerCase())) {
        const newStudent = {
          id: 's-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          name: name,
          grades: {},
        };
        targetGroup.assignments.forEach(a => {
          newStudent.grades[a.id] = null;
        });
        targetGroup.students.push(newStudent);
        addedCount++;
      }
    });

    targetGroup.students.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    state.currentGroupId = targetGroup.id;
    saveData();
    closeModal('modal-import-students');
    renderApp();
    showToast(`Добавлено ${addedCount} студентов в группу ${targetGroup.name}!`, 'success');
  }

  /* ==========================================================================
     Автоматический коммит на GitHub через GitHub REST API
     ========================================================================== */

  function utf8ToBase64(str) {
    return window.btoa(unescape(encodeURIComponent(str)));
  }

  function updateGitHubStatusCard() {
    const card = document.getElementById('github-connection-status');
    if (!card) return;
    const { owner, repo, token } = state.githubSettings;
    if (owner && repo && token) {
      card.className = 'github-status-card connected';
      card.innerHTML = `<span>🟢 Интеграция настроена: <b>${escapeHtml(owner)}/${escapeHtml(repo)}</b></span>`;
    } else {
      card.className = 'github-status-card disconnected';
      card.innerHTML = `<span>⚪ Интеграция не настроена (введите токен и репозиторий)</span>`;
    }
  }

  function openGitHubSettingsModal() {
    const ownerInput = document.getElementById('github-owner-input');
    const repoInput = document.getElementById('github-repo-input');
    const branchInput = document.getElementById('github-branch-input');
    const tokenInput = document.getElementById('github-token-input');

    if (ownerInput) ownerInput.value = state.githubSettings.owner || '';
    if (repoInput) repoInput.value = state.githubSettings.repo || '';
    if (branchInput) branchInput.value = state.githubSettings.branch || 'main';
    if (tokenInput) tokenInput.value = state.githubSettings.token || '';

    updateGitHubStatusCard();
    openModal('modal-github-settings');
  }

  async function testGitHubConnection() {
    const owner = document.getElementById('github-owner-input').value.trim();
    const repo = document.getElementById('github-repo-input').value.trim();
    const token = document.getElementById('github-token-input').value.trim();

    if (!owner || !repo || !token) {
      showToast('Заполните владельца, репозиторий и токен', 'error');
      return;
    }

    try {
      showToast('Проверка соединения с GitHub API...', 'info');
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (resp.ok) {
        const repoData = await resp.json();
        showToast(`Связь установлена! Репозиторий "${repoData.full_name}" доступен.`, 'success');
        const card = document.getElementById('github-connection-status');
        if (card) {
          card.className = 'github-status-card connected';
          card.innerHTML = `<span>🟢 Связь подтверждена: <b>${escapeHtml(repoData.full_name)}</b></span>`;
        }
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(`Ошибка GitHub: ${err.message || resp.statusText}`, 'error');
      }
    } catch (e) {
      showToast(`Ошибка сети при связи с GitHub API: ${e.message}`, 'error');
    }
  }

  async function commitFileToGitHub(path, contentStr, commitMessage) {
    const { owner, repo, branch, token } = state.githubSettings;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    let sha = undefined;
    try {
      const getResp = await fetch(`${apiUrl}?ref=${branch}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (getResp.ok) {
        const fileInfo = await getResp.json();
        sha = fileInfo.sha;
      }
    } catch (e) {
      console.log('Файл пока не существует, будет создан новый');
    }

    const body = {
      message: commitMessage,
      content: utf8ToBase64(contentStr),
      branch: branch || 'main'
    };
    if (sha) {
      body.sha = sha;
    }

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!putResp.ok) {
      const errData = await putResp.json().catch(() => ({}));
      throw new Error(errData.message || `Ошибка ${putResp.status}`);
    }

    return await putResp.json();
  }

  async function publishToGitHub() {
    const { owner, repo, branch, token } = state.githubSettings;
    if (!owner || !repo || !token) {
      openGitHubSettingsModal();
      showToast('Сначала настройте подключение к GitHub (укажите репозиторий и токен)', 'info');
      return;
    }

    const btn = document.getElementById('btn-quick-github-sync');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Коммит на GitHub...';
    }

    try {
      showToast('Создание коммита на GitHub...', 'info');

      const jsonContent = JSON.stringify(state.data, null, 2);
      const jsContent = `/**\n * Автоматически сгенерированные данные электронного журнала\n * Экспортировано: ${new Date().toISOString()}\n */\nwindow.DEFAULT_REGISTER_DATA = ${JSON.stringify(state.data, null, 2)};\n`;

      const timeStr = new Date().toLocaleString('ru-RU');
      const commitMsg = `Обновление успеваемости (из журнала) — ${timeStr}`;

      await commitFileToGitHub('data.json', jsonContent, commitMsg);
      await commitFileToGitHub('data.js', jsContent, commitMsg);

      showToast('🚀 Успешно опубликовано на GitHub! GitHub Pages автоматически обновит сайт в течение 1-2 минут.', 'success');
    } catch (err) {
      console.error('Ошибка публикации на GitHub:', err);
      showToast(`Ошибка публикации: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>🚀</span> Опубликовать на GitHub';
      }
    }
  }

  /* ==========================================================================
     Слушатели событий таблицы и панели управления
     ========================================================================== */

  function attachTableAdminListeners() {
    // Редактирование задания
    document.querySelectorAll('[data-edit-assign]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openEditAssignmentModal(btn.dataset.editAssign);
      };
    });

    // Удаление задания
    document.querySelectorAll('[data-delete-assign]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        deleteAssignment(btn.dataset.deleteAssign);
      };
    });

    // Редактирование студента
    document.querySelectorAll('[data-edit-student]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openStudentModal(btn.dataset.editStudent);
      };
    });

    // Удаление студента
    document.querySelectorAll('[data-delete-student]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        deleteStudent(btn.dataset.deleteStudent);
      };
    });
  }

  // Привязка основных элементов интерфейса
  function setupEventListeners() {
    // Вход студента по ключу группы
    document.getElementById('form-student-gate')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const keyInput = document.getElementById('gate-key-input');
      const entered = keyInput ? keyInput.value.trim() : '';
      const errMsg = document.getElementById('gate-error-message');
      if (errMsg) errMsg.style.display = 'none';

      const ok = handleGateLogin(entered);
      if (!ok && errMsg) {
        errMsg.style.display = 'block';
      }
    });

    // Вход преподавателя со стартового экрана ключа
    document.getElementById('btn-gate-teacher-login')?.addEventListener('click', handleAdminToggle);

    // Смена группы студентом
    document.getElementById('btn-student-switch-group')?.addEventListener('click', handleStudentSwitchGroup);

    // Кнопка входа/выхода администратора
    document.getElementById('btn-admin-login')?.addEventListener('click', handleAdminToggle);
    document.getElementById('btn-admin-logout')?.addEventListener('click', handleAdminToggle);

    // Поиск по студентам
    const searchInput = document.getElementById('student-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        renderTable();
      });
    }

    // Кнопка добавления студента
    document.getElementById('btn-add-student')?.addEventListener('click', () => {
      openStudentModal();
    });

    // Кнопка добавления задания
    document.getElementById('btn-add-assignment')?.addEventListener('click', () => {
      openEditAssignmentModal();
    });

    // Кнопка управления группами
    document.getElementById('btn-manage-groups')?.addEventListener('click', () => {
      openGroupManagerModal();
    });

    // Кнопка смены пароля
    document.getElementById('btn-open-change-password')?.addEventListener('click', () => {
      openModal('modal-change-password');
    });

    // Кнопка экспорта / сохранения для GitHub Pages
    document.getElementById('btn-export-data')?.addEventListener('click', openExportModal);
    document.getElementById('btn-download-json')?.addEventListener('click', exportDataJson);
    document.getElementById('btn-download-js')?.addEventListener('click', exportDataJs);

    // Импорт студентов
    document.getElementById('btn-open-import')?.addEventListener('click', openImportModal);

    // Зона загрузки файла для импорта
    const dropzone = document.getElementById('import-dropzone');
    const fileInput = document.getElementById('import-file-input');

    dropzone?.addEventListener('click', () => {
      fileInput?.click();
    });

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleImportFile(files[0]);
      }
    });

    fileInput?.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleImportFile(files[0]);
      }
    });

    function handleImportFile(file) {
      const reader = new FileReader();
      reader.onload = (re) => {
        const content = re.target.result;
        const parsed = parseFileContent(content);
        renderImportPreview(parsed);
      };
      reader.onerror = () => {
        showToast('Ошибка чтения файла', 'error');
      };
      reader.readAsText(file, 'utf-8');
    }

    // Распознавание из текстового поля
    document.getElementById('btn-parse-textarea')?.addEventListener('click', () => {
      const textarea = document.getElementById('import-raw-textarea');
      const content = textarea ? textarea.value.trim() : '';
      if (!content) {
        showToast('Вставьте текст или HTML таблицы', 'error');
        return;
      }
      const parsed = parseFileContent(content);
      renderImportPreview(parsed);
    });

    // Подтверждение импорта
    document.getElementById('btn-confirm-import')?.addEventListener('click', confirmImport);

    // Переключение видимости поля названия новой группы при смене выбора
    document.getElementById('import-target-group-select')?.addEventListener('change', toggleNewGroupBox);

    // Публикация и настройки GitHub
    document.getElementById('btn-quick-github-sync')?.addEventListener('click', publishToGitHub);
    document.getElementById('btn-open-github-settings')?.addEventListener('click', openGitHubSettingsModal);
    document.getElementById('btn-test-github-conn')?.addEventListener('click', testGitHubConnection);

    document.getElementById('form-github-settings')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const owner = document.getElementById('github-owner-input').value.trim();
      const repo = document.getElementById('github-repo-input').value.trim();
      const branch = document.getElementById('github-branch-input').value.trim() || 'main';
      const token = document.getElementById('github-token-input').value.trim();

      state.githubSettings = { owner, repo, branch, token };
      localStorage.setItem(GITHUB_SETTINGS_KEY, JSON.stringify(state.githubSettings));
      closeModal('modal-github-settings');
      showToast('Настройки GitHub успешно сохранены!', 'success');
    });

    // Обработка прикрепления картинки к заданию
    const assignFileInput = document.getElementById('assign-image-file');
    assignFileInput?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        if (!file.type.startsWith('image/')) {
          showToast('Пожалуйста, выберите файл изображения (PNG, JPG, SVG, WebP)', 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = (re) => {
          state.editingAssignmentImage = re.target.result;
          updateImageEditorPreview();
        };
        reader.readAsDataURL(file);
      }
    });

    const assignUrlInput = document.getElementById('assign-image-url');
    assignUrlInput?.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (val) {
        state.editingAssignmentImage = val;
        updateImageEditorPreview();
      }
    });

    document.getElementById('btn-remove-assign-image')?.addEventListener('click', () => {
      state.editingAssignmentImage = null;
      if (assignFileInput) assignFileInput.value = '';
      if (assignUrlInput) assignUrlInput.value = '';
      updateImageEditorPreview();
    });

    // Копирование JSON в буфер обмена
    document.getElementById('btn-copy-json')?.addEventListener('click', () => {
      const textarea = document.getElementById('export-json-preview');
      if (textarea) {
        navigator.clipboard.writeText(textarea.value).then(() => {
          showToast('JSON скопирован в буфер обмена!', 'success');
        });
      }
    });

    // Кнопка сброса к исходным данным
    document.getElementById('btn-reset-data')?.addEventListener('click', () => {
      if (confirm('Сбросить все внесённые изменения к исходным демонстрационным данным?')) {
        localStorage.removeItem(STORAGE_KEY);
        if (window.DEFAULT_REGISTER_DATA) {
          state.data = JSON.parse(JSON.stringify(window.DEFAULT_REGISTER_DATA));
        }
        renderApp();
        showToast('Данные сброшены к исходным', 'info');
      }
    });
  }

  // Запуск при загрузке страницы
  document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initData();
  });

})();
