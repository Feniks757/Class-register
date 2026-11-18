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
    editingAssignmentImages: [], // Массив картинок для текущего редактируемого задания
    parsedImportData: null,
    githubSettings: {
      owner: '',
      repo: '',
      branch: 'main',
      token: ''
    }
  };

  // Импорт вспомогательных функций из модулей
  const {
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
    optimizeRegisterDataImages,
    idbGet,
    idbSet,
    idbDelete
  } = window.AppUtils;

  const { parseStudentsFromHTML, parseStudentsFromText, parseFileContent } = window.AppParser;
  const { updateGitHubStatusCard, testGitHubConnection, commitFileToGitHub, commitMultipleFilesToGitHub } = window.AppGitHub;

  /* ==========================================================================
     Загрузка и сохранение данных
     ========================================================================== */

  async function initData() {
    // Очистка устаревших ключей предыдущих версий для полного сброса
    localStorage.removeItem('class_register_data_v1');
    localStorage.removeItem('class_register_data_v2');

    // 1. Попытка загрузить из localStorage
    let localData = null;
    const local = localStorage.getItem(STORAGE_KEY);
    if (local) {
      try {
        localData = JSON.parse(local);
      } catch (e) {
        console.warn('Ошибка парсинга localStorage:', e);
      }
    }

    // 2. Попытка загрузить из надежного хранилища IndexedDB (где нет лимита 5 МБ)
    let idbData = null;
    if (idbGet) {
      try {
        idbData = await idbGet(STORAGE_KEY);
      } catch (err) {
        console.warn('Ошибка чтения IndexedDB:', err);
      }
    }

    // Выбираем наиболее свежие данные между localStorage и IndexedDB
    if (localData && idbData) {
      const localTime = localData.lastModified || 0;
      const idbTime = idbData.lastModified || 0;
      state.data = idbTime >= localTime ? idbData : localData;
    } else {
      state.data = localData || idbData || null;
    }

    // 3. Если данных нет, пробуем data.json или data.js
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

    // 4. Fallback на глобальный объект window.DEFAULT_REGISTER_DATA
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

      // Фоновая оптимизация и сжатие тяжелых картинок в базе данных
      if (typeof optimizeRegisterDataImages === 'function') {
        optimizeRegisterDataImages(state.data).then(modified => {
          if (modified) {
            saveData();
            console.log('База данных успешно оптимизирована и сжата');
          }
        });
      }
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

  function saveData(notify = false) {
    if (!state.data) return;

    state.data.lastModified = Date.now();

    // 1. Асинхронно сохраняем в IndexedDB (без лимита в 5 МБ)
    if (idbSet) {
      idbSet(STORAGE_KEY, state.data).catch(err => {
        console.warn('IndexedDB save error:', err);
      });
    }

    // 2. Сохраняем в localStorage для мгновенного синхронного доступа
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    } catch (e) {
      // При превышении квоты localStorage (5 МБ) данные все равно сохранены в памяти и IndexedDB
      console.warn('Предупреждение: превышена квота localStorage (5 МБ). Данные сохранены в IndexedDB.', e);
    }

    if (notify) {
      showToast('Изменения сохранены локально', 'success');
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

  function isHwSubmitted(val) {
    if (val === null || val === undefined) return false;
    const str = String(val).trim().toLowerCase();
    if (str === '' || str === 'not_submitted' || str === 'не сдано' || str === '⚠️ не сдано' || str === 'незачет' || str === 'незачёт' || str === 'долг' || str === '—' || str === '-') {
      return false;
    }
    return true;
  }

  function isHwDebt(val, deadline) {
    if (val === null || val === undefined || String(val).trim() === '') {
      return isDeadlinePassed(deadline);
    }
    const str = String(val).trim().toLowerCase();
    if (str === 'not_submitted' || str === 'не сдано' || str === '⚠️ не сдано' || str === 'незачет' || str === 'незачёт' || str === 'долг') {
      return true;
    }
    return false;
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
        if (isHwSubmitted(val)) {
          totalHwSubmitted++;
        } else if (isHwDebt(val, assign.deadline)) {
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

      const assignImages = extractImages(assign.images || assign.image);
      const hasImages = assignImages.length > 0;
      const assignLinks = extractLinks(assign.videoUrl);
      const hasLinks = assignLinks.length > 0;

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
            ${hasImages ? `<span class="assignment-image-indicator" title="${assignImages.length > 1 ? assignImages.length + ' изображений' : 'Прикреплена картинка/схема'}">🖼️ ${assignImages.length > 1 ? assignImages.length + ' фото' : 'Картинка'}</span>` : ''}
            ${hasLinks ? `<span class="assignment-video-indicator" title="${assignLinks.length > 1 ? assignLinks.length + ' ссылок на материалы' : 'Прикреплена ссылка на материалы'}">🔗 ${assignLinks.length > 1 ? assignLinks.length + ' ссылки' : 'Ссылка'}</span>` : ''}
          </div>
          <div class="assignment-admin-actions">
            <button class="btn btn-secondary btn-sm" style="padding: 2px 5px; font-size: 0.72rem;" title="Скопировать в другие группы" data-copy-assign="${assign.id}">📑</button>
            <button class="btn btn-secondary btn-sm" style="padding: 2px 6px; font-size: 0.72rem;" data-edit-assign="${assign.id}">✎ Изм.</button>
            <button class="btn btn-outline-danger btn-sm" style="padding: 2px 6px; font-size: 0.72rem;" data-delete-assign="${assign.id}">🗑</button>
          </div>
        </div>
      `;

      // Клик по заголовку открывает модалку с описанием задания
      thAssign.addEventListener('click', (e) => {
        if (e.target.closest('[data-copy-assign]') || e.target.closest('[data-edit-assign]') || e.target.closest('[data-delete-assign]')) return;
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
        if (isHwSubmitted(v)) {
          studentHwDone++;
        } else if (isHwDebt(v, a.deadline)) {
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
          // ДОМАШНЕЕ ЗАДАНИЕ: поддержка стандартных статусов и любых произвольных текстовых оценок
          if (val !== null && val !== undefined && String(val).trim() !== '') {
            const raw = String(val).trim();
            const lower = raw.toLowerCase();
            if (lower === 'submitted' || lower === 'сдано' || lower === '✓ сдано') {
              tdGrade.classList.add('is-graded');
              tdGrade.innerHTML = `<span class="badge-hw badge-hw-submitted">✓ Сдано</span>`;
            } else if (lower === 'late' || lower === 'сдано с опозданием' || lower === '⏰ сдано с опозданием') {
              tdGrade.classList.add('is-graded');
              tdGrade.innerHTML = `<span class="badge-hw badge-hw-late">⏰ Сдано с опозданием</span>`;
            } else if (lower === 'not_submitted' || lower === 'не сдано' || lower === '⚠️ не сдано' || lower === 'незачет' || lower === 'незачёт' || lower === 'долг') {
              tdGrade.classList.add('is-overdue');
              tdGrade.innerHTML = `<span class="badge-hw badge-hw-not-submitted">⚠️ ${escapeHtml(raw.replace(/^[⚠️\s]+/, '') || 'Не сдано')}</span>`;
            } else {
              // Произвольная текстовая отметка (5, 4+, зачёт, 10/10 и др.)
              tdGrade.classList.add('is-graded');
              tdGrade.innerHTML = `<span class="badge-hw-text" title="${escapeHtml(raw)}">${escapeHtml(raw)}</span>`;
            }
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

  function ensureHwDatalist() {
    let dl = document.getElementById('hw-grade-options-list');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'hw-grade-options-list';
      dl.innerHTML = `
        <option value="5"></option>
        <option value="4"></option>
        <option value="3"></option>
        <option value="✓ Сдано"></option>
        <option value="Зачтено"></option>
        <option value="⏰ Сдано с опозданием"></option>
        <option value="⚠️ Не сдано"></option>
      `;
      document.body.appendChild(dl);
    }
  }

  function ensureCwDatalist() {
    let dl = document.getElementById('cw-grade-options-list');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'cw-grade-options-list';
      dl.innerHTML = `
        <option value="5"></option>
        <option value="4"></option>
        <option value="3"></option>
        <option value="+"></option>
        <option value="Зачёт"></option>
        <option value="Был"></option>
        <option value="Отл"></option>
        <option value="Н"></option>
      `;
      document.body.appendChild(dl);
    }
  }

  function startInlineHomeworkEdit(cell, studentId, assignId, currentVal) {
    if (cell.querySelector('.inline-hw-input')) return;

    ensureHwDatalist();

    const originalHTML = cell.innerHTML;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-hw-input';
    input.setAttribute('list', 'hw-grade-options-list');

    let displayVal = (currentVal !== null && currentVal !== undefined) ? String(currentVal) : '';
    if (displayVal === 'submitted') displayVal = '✓ Сдано';
    else if (displayVal === 'late') displayVal = '⏰ Сдано с опозданием';
    else if (displayVal === 'not_submitted') displayVal = '⚠️ Не сдано';

    input.value = displayVal;
    input.placeholder = '5, 4, ✓ Сдано...';

    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    const commitChange = () => {
      if (committed) return;
      committed = true;

      const rawVal = input.value.trim();
      let chosen = null;
      if (rawVal !== '') {
        const lower = rawVal.toLowerCase();
        if (lower === '✓ сдано' || lower === 'сдано') chosen = 'submitted';
        else if (lower === '⏰ сдано с опозданием' || lower === 'сдано с опозданием' || lower === 'late') chosen = 'late';
        else if (lower === '⚠️ не сдано' || lower === 'не сдано' || lower === 'not_submitted') chosen = 'not_submitted';
        else chosen = rawVal;
      }

      const group = getCurrentGroup();
      if (!group) return;
      const student = group.students.find(s => s.id === studentId);
      if (!student) return;

      student.grades[assignId] = chosen;
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

  function startInlineClassworkEdit(cell, studentId, assignId, currentVal) {
    if (cell.querySelector('.inline-cw-input')) return;

    ensureCwDatalist();

    const originalHTML = cell.innerHTML;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-cw-input';
    input.setAttribute('list', 'cw-grade-options-list');
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

  function updateModalBodyLock() {
    const hasActiveModal = document.querySelector('.modal-overlay.active') !== null;
    const lightbox = document.getElementById('modal-image-lightbox');
    const hasActiveLightbox = lightbox && (lightbox.style.display === 'flex' || lightbox.style.display === 'block');
    if (hasActiveModal || hasActiveLightbox) {
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
  }

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
      const modalBody = modal.querySelector('.modal-body');
      if (modalBody) {
        modalBody.scrollTop = 0;
      }
      updateModalBodyLock();
    }
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
      updateModalBodyLock();
    }
  }

  /* ==========================================================================
     Полноэкранный просмотр изображений (Lightbox / Карусель)
     ========================================================================== */

  let lightboxState = {
    images: [],
    currentIndex: 0,
    titlePrefix: ''
  };

  function openLightbox(imagesInput, startIndex = 0, titlePrefix = '') {
    let images = [];
    if (Array.isArray(imagesInput)) {
      images = imagesInput.filter(Boolean);
    } else if (typeof imagesInput === 'string' && imagesInput) {
      images = [imagesInput];
    }
    if (images.length === 0) return;

    lightboxState.images = images;
    lightboxState.currentIndex = Math.max(0, Math.min(startIndex, images.length - 1));
    lightboxState.titlePrefix = titlePrefix || '';

    renderLightboxSlide();

    const lightbox = document.getElementById('modal-image-lightbox');
    if (lightbox) {
      lightbox.style.display = 'flex';
      updateModalBodyLock();
    }
  }

  function renderLightboxSlide() {
    const { images, currentIndex, titlePrefix } = lightboxState;
    if (images.length === 0) return;

    const currentSrc = images[currentIndex];
    const img = document.getElementById('lightbox-img');
    const cap = document.getElementById('lightbox-caption');
    const counter = document.getElementById('lightbox-counter');
    const ext = document.getElementById('lightbox-open-external');
    const prevBtn = document.getElementById('lightbox-prev-btn');
    const nextBtn = document.getElementById('lightbox-next-btn');
    const thumbsBar = document.getElementById('lightbox-thumbs-bar');

    if (img) {
      img.src = currentSrc;
      img.alt = `Иллюстрация ${currentIndex + 1}`;
    }

    if (counter) {
      if (images.length > 1) {
        counter.style.display = 'inline-block';
        counter.textContent = `${currentIndex + 1} / ${images.length}`;
      } else {
        counter.style.display = 'none';
      }
    }

    if (cap) {
      const prefix = titlePrefix ? `${titlePrefix}` : 'Иллюстрация';
      cap.textContent = images.length > 1 ? `${prefix} (фото ${currentIndex + 1} из ${images.length})` : prefix;
    }

    if (ext) {
      ext.href = currentSrc;
      ext.style.display = currentSrc.startsWith('http') || currentSrc.startsWith('data:') ? 'inline-flex' : 'none';
    }

    // Кнопки перелистывания видны только если фото больше одного
    if (prevBtn) prevBtn.style.display = images.length > 1 ? 'flex' : 'none';
    if (nextBtn) nextBtn.style.display = images.length > 1 ? 'flex' : 'none';

    // Лента миниатюр внизу экрана
    if (thumbsBar) {
      if (images.length > 1) {
        thumbsBar.style.display = 'flex';
        thumbsBar.innerHTML = '';
        images.forEach((src, idx) => {
          const thumb = document.createElement('div');
          thumb.className = `lightbox-thumb-item ${idx === currentIndex ? 'active' : ''}`;
          thumb.title = `Перейти к фото ${idx + 1}`;
          thumb.innerHTML = `<img src="${escapeHtml(src)}" alt="Миниатюра ${idx + 1}">`;
          thumb.onclick = (e) => {
            e.stopPropagation();
            lightboxState.currentIndex = idx;
            renderLightboxSlide();
          };
          thumbsBar.appendChild(thumb);
        });
      } else {
        thumbsBar.style.display = 'none';
        thumbsBar.innerHTML = '';
      }
    }
  }

  function lightboxNext() {
    if (lightboxState.images.length <= 1) return;
    lightboxState.currentIndex = (lightboxState.currentIndex + 1) % lightboxState.images.length;
    renderLightboxSlide();
  }

  function lightboxPrev() {
    if (lightboxState.images.length <= 1) return;
    lightboxState.currentIndex = (lightboxState.currentIndex - 1 + lightboxState.images.length) % lightboxState.images.length;
    renderLightboxSlide();
  }

  function closeLightbox() {
    const lightbox = document.getElementById('modal-image-lightbox');
    if (!lightbox) return;
    lightbox.style.display = 'none';
    const img = document.getElementById('lightbox-img');
    if (img) img.src = '';
    updateModalBodyLock();
  }

  // Клик вне карточки модалки закрывает её
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
        updateModalBodyLock();
      }
    });
  });

  // Кнопки крестика
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-overlay');
      if (modal) {
        modal.classList.remove('active');
        updateModalBodyLock();
      }
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

    // Отображение прикрепленных изображений (галерея / карусель)
    const imageBox = document.getElementById('modal-assign-detail-image-box');
    const imagesGallery = document.getElementById('modal-assign-detail-images-gallery');
    const assignImages = extractImages(assign.images || assign.image);

    if (imageBox && imagesGallery) {
      if (assignImages.length === 1) {
        imageBox.style.display = 'block';
        imagesGallery.innerHTML = '';
        const imgWrap = document.createElement('div');
        imgWrap.className = 'assignment-modal-gallery-item';
        imgWrap.title = 'Кликните для просмотра в полном размере';
        imgWrap.innerHTML = `
          <img src="${escapeHtml(assignImages[0])}" alt="Иллюстрация к заданию" loading="lazy">
          <div class="gallery-item-badge">🔍 Полноразмерный просмотр</div>
        `;
        imgWrap.onclick = () => openLightbox(assignImages, 0, assign.title);
        imagesGallery.appendChild(imgWrap);
      } else if (assignImages.length > 1) {
        imageBox.style.display = 'block';
        imagesGallery.innerHTML = '';

        let cardCurrentIndex = 0;
        const carouselWrap = document.createElement('div');
        carouselWrap.className = 'card-carousel';

        carouselWrap.innerHTML = `
          <div class="card-carousel-main" title="Кликните для открытия полноэкранного просмотра">
            <img id="card-carousel-active-img" src="${escapeHtml(assignImages[0])}" alt="Иллюстрация 1">
            <button type="button" class="card-carousel-nav-btn card-carousel-prev" title="Предыдущее фото (←)">&#10094;</button>
            <button type="button" class="card-carousel-nav-btn card-carousel-next" title="Следующее фото (→)">&#10095;</button>
            <div class="card-carousel-badge" id="card-carousel-badge">1 / ${assignImages.length}</div>
            <div class="card-carousel-fullscreen-hint">🔍 На весь экран</div>
          </div>
          <div class="card-carousel-thumbs" id="card-carousel-thumbs">
            ${assignImages.map((src, i) => `
              <div class="card-carousel-thumb-item ${i === 0 ? 'active' : ''}" data-index="${i}" title="Фото ${i + 1}">
                <img src="${escapeHtml(src)}" alt="Миниатюра ${i + 1}">
              </div>
            `).join('')}
          </div>
        `;

        const activeImg = carouselWrap.querySelector('#card-carousel-active-img');
        const badgeEl = carouselWrap.querySelector('#card-carousel-badge');
        const prevBtn = carouselWrap.querySelector('.card-carousel-prev');
        const nextBtn = carouselWrap.querySelector('.card-carousel-next');
        const thumbs = carouselWrap.querySelectorAll('.card-carousel-thumb-item');

        function updateCardSlide(newIdx) {
          cardCurrentIndex = (newIdx + assignImages.length) % assignImages.length;
          activeImg.src = assignImages[cardCurrentIndex];
          activeImg.alt = `Иллюстрация ${cardCurrentIndex + 1}`;
          badgeEl.textContent = `${cardCurrentIndex + 1} / ${assignImages.length}`;
          thumbs.forEach((th, i) => {
            th.classList.toggle('active', i === cardCurrentIndex);
          });
        }

        prevBtn.onclick = (e) => {
          e.stopPropagation();
          updateCardSlide(cardCurrentIndex - 1);
        };

        nextBtn.onclick = (e) => {
          e.stopPropagation();
          updateCardSlide(cardCurrentIndex + 1);
        };

        thumbs.forEach((th, i) => {
          th.onclick = (e) => {
            e.stopPropagation();
            updateCardSlide(i);
          };
        });

        // Клик по основному изображению открывает полноэкранный Lightbox на текущем фото
        carouselWrap.querySelector('.card-carousel-main').onclick = (e) => {
          if (e.target.closest('.card-carousel-nav-btn')) return;
          openLightbox(assignImages, cardCurrentIndex, assign.title);
        };

        imagesGallery.appendChild(carouselWrap);
      } else {
        imageBox.style.display = 'none';
        imagesGallery.innerHTML = '';
      }
    }

    // Отображение ссылок и материалов к заданию
    const videoBox = document.getElementById('modal-assign-detail-video-box');
    const linksList = document.getElementById('modal-assign-detail-links-list');
    const linksLabel = document.getElementById('modal-assign-detail-links-label');
    const assignLinks = extractLinks(assign.videoUrl);

    if (videoBox && linksList) {
      if (assignLinks.length > 0) {
        videoBox.style.display = 'block';
        if (linksLabel) {
          linksLabel.textContent = assignLinks.length === 1 ? 'Ссылка на материал к заданию:' : `Полезные ссылки и материалы (${assignLinks.length}):`;
        }
        linksList.innerHTML = '';
        assignLinks.forEach((url, i) => {
          const meta = getLinkMeta(url);
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'btn btn-primary btn-sm';
          a.style.cssText = `background:${meta.bg}; border-color:${meta.border}; display:inline-flex; align-items:center; gap:0.4rem; max-width:100%; word-break:break-all; text-align:left; line-height:1.3; padding:0.45rem 0.85rem;`;
          
          let displayUrl = url.replace(/^https?:\/\//i, '');
          if (displayUrl.length > 55) {
            displayUrl = displayUrl.slice(0, 52) + '...';
          }
          a.innerHTML = `<span>${meta.icon}</span> <span><b>${meta.label}</b>: <span style="opacity:0.9; font-weight:normal; font-size:0.8rem;">${escapeHtml(displayUrl)}</span></span>`;
          linksList.appendChild(a);
        });
      } else {
        videoBox.style.display = 'none';
        linksList.innerHTML = '';
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
        if (isHwSubmitted(val)) {
          passedCount++;
        } else if (isHwDebt(val, assign.deadline)) {
          debtCount++;
        }
      });
      if (statPassedEl) statPassedEl.textContent = `${passedCount} из ${group.students.length}`;
      if (statDebtsEl) statDebtsEl.textContent = debtCount;
    }

    // Кнопки копирования и редактирования задания из модалки для админа
    const copyBtn = document.getElementById('modal-assign-btn-copy');
    if (copyBtn) {
      copyBtn.style.display = state.isAdmin ? 'inline-flex' : 'none';
      copyBtn.onclick = () => {
        closeModal('modal-assignment-detail');
        openCopyAssignmentModal(assign.id);
      };
    }

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
    const previewList = document.getElementById('assign-images-preview-list');
    if (!previewList) return;

    if (!state.editingAssignmentImages || state.editingAssignmentImages.length === 0) {
      previewList.style.display = 'none';
      previewList.innerHTML = '';
      return;
    }

    previewList.style.display = 'grid';
    previewList.innerHTML = '';
    state.editingAssignmentImages.forEach((imgSrc, idx) => {
      const item = document.createElement('div');
      item.className = 'image-preview-item';
      item.title = `Изображение ${idx + 1} (кликните для полноразмерного просмотра)`;
      item.innerHTML = `
        <img src="${escapeHtml(imgSrc)}" alt="Миниатюра ${idx + 1}">
        <button type="button" class="btn-remove-thumb" title="Удалить это изображение" data-index="${idx}">✕</button>
      `;
      item.onclick = (e) => {
        if (e.target.closest('.btn-remove-thumb')) return;
        openLightbox(state.editingAssignmentImages, idx, 'Новое задание');
      };
      item.querySelector('.btn-remove-thumb').addEventListener('click', (e) => {
        e.stopPropagation();
        state.editingAssignmentImages.splice(idx, 1);
        updateImageEditorPreview();
      });
      previewList.appendChild(item);
    });
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
    const urlInput = document.getElementById('assign-image-url');
    const multiGroupBox = document.getElementById('assign-multi-group-box');
    const targetGroupsContainer = document.getElementById('assign-target-groups-list');

    if (fileInput) fileInput.value = '';
    if (urlInput) urlInput.value = '';

    let defaultIso = '';
    if (assignId) {
      const assign = group.assignments.find(a => a.id === assignId);
      if (!assign) return;
      if (modalTitle) modalTitle.textContent = 'Редактировать задание';
      if (typeSelect) typeSelect.value = assign.type || 'homework';
      if (titleInput) titleInput.value = assign.title;
      if (descInput) descInput.value = assign.description;
      if (videoInput) videoInput.value = assign.videoUrl || '';
      state.editingAssignmentImages = extractImages(assign.images || assign.image);
      if (deadlineInput) {
        // Преобразуем формат в YYYY-MM-DDTHH:mm
        const d = new Date(assign.deadline);
        defaultIso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        deadlineInput.value = defaultIso;
      }
      // При редактировании скрываем блок мульти-создания (для этого есть отдельная кнопка "Скопировать")
      if (multiGroupBox) multiGroupBox.style.display = 'none';
    } else {
      if (modalTitle) modalTitle.textContent = 'Добавить новое задание';
      if (typeSelect) typeSelect.value = 'homework';
      if (titleInput) titleInput.value = '';
      if (descInput) descInput.value = '';
      if (videoInput) videoInput.value = '';
      state.editingAssignmentImages = [];
      if (deadlineInput) {
        // Дедлайн по умолчанию через 7 дней
        const d = new Date();
        d.setDate(d.getDate() + 7);
        d.setHours(23, 59, 0, 0);
        defaultIso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        deadlineInput.value = defaultIso;
      }

      // Заполняем список других групп для одновременного добавления
      if (multiGroupBox && targetGroupsContainer) {
        const otherGroups = (state.data.groups || []).filter(g => g.id !== group.id);
        if (otherGroups.length > 0) {
          multiGroupBox.style.display = 'block';
          targetGroupsContainer.innerHTML = '';
          otherGroups.forEach(g => {
            const row = document.createElement('div');
            row.className = 'assign-target-group-row';
            row.innerHTML = `
              <label class="assign-target-group-info">
                <input type="checkbox" class="assign-target-group-checkbox" data-group-id="${g.id}">
                <div>
                  <div class="assign-target-group-name">${escapeHtml(g.name)}</div>
                  <div class="assign-target-group-sub">${g.students.length} студентов</div>
                </div>
              </label>
              <div class="assign-target-group-deadline-wrap">
                <span style="font-size: 0.72rem; color: var(--text-muted);">Дедлайн:</span>
                <input type="datetime-local" class="assign-target-group-deadline-input" data-deadline-group-id="${g.id}" value="${defaultIso}">
              </div>
            `;
            targetGroupsContainer.appendChild(row);
          });
        } else {
          multiGroupBox.style.display = 'none';
        }
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
    const images = state.editingAssignmentImages.length > 0 ? [...state.editingAssignmentImages] : null;

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
        assign.images = images;
        delete assign.image;
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
        images
      });

      // Инициализируем оценки студентов как null
      group.students.forEach(s => {
        s.grades[newId] = null;
      });

      // Также создаем копии в других выбранных группах (если отмечены)
      const targetCheckboxes = document.querySelectorAll('#assign-target-groups-list .assign-target-group-checkbox:checked');
      let extraCreatedCount = 0;
      targetCheckboxes.forEach(cb => {
        const targetGid = cb.getAttribute('data-group-id');
        const targetGroup = (state.data.groups || []).find(g => g.id === targetGid);
        if (targetGroup) {
          const dlInput = document.querySelector(`#assign-target-groups-list [data-deadline-group-id="${targetGid}"]`);
          const customDlVal = dlInput ? dlInput.value : null;
          const groupDeadline = customDlVal ? new Date(customDlVal).toISOString() : deadline;

          const cloneId = (type === 'classwork' ? 'cw-' : 'hw-') + Date.now() + '-' + Math.floor(Math.random() * 1000);
          targetGroup.assignments.push({
            id: cloneId,
            type,
            title,
            description,
            deadline: groupDeadline,
            videoUrl,
            images
          });

          targetGroup.students.forEach(s => {
            s.grades[cloneId] = null;
          });
          extraCreatedCount++;
        }
      });

      if (extraCreatedCount > 0) {
        showToast(`Задание создано в текущей группе и продублировано в ${extraCreatedCount} других групп!`, 'success');
      } else {
        showToast('Новое задание добавлено', 'success');
      }
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
     Копирование задания в другие группы (Дублирование)
     ========================================================================== */

  let copyingAssignmentContext = null;

  function openCopyAssignmentModal(assignId) {
    const currentGroup = getCurrentGroup();
    if (!currentGroup) return;

    const assign = currentGroup.assignments.find(a => a.id === assignId);
    if (!assign) return;

    copyingAssignmentContext = {
      sourceGroupId: currentGroup.id,
      assign: JSON.parse(JSON.stringify(assign))
    };

    const titleEl = document.getElementById('copy-assign-source-title');
    const groupEl = document.getElementById('copy-assign-source-group');
    const listContainer = document.getElementById('copy-assign-targets-list');

    if (titleEl) titleEl.textContent = `${assign.type === 'classwork' ? '🏫' : '🏠'} ${assign.title}`;
    if (groupEl) groupEl.textContent = `Исходная группа: ${currentGroup.name}`;

    if (listContainer) {
      listContainer.innerHTML = '';
      const otherGroups = (state.data.groups || []).filter(g => g.id !== currentGroup.id);

      if (otherGroups.length === 0) {
        listContainer.innerHTML = '<div style="font-size:0.85rem; color:var(--text-muted); padding:0.5rem;">Нет других групп для копирования. Создайте группы в «Управлении группами».</div>';
      } else {
        const d = new Date(assign.deadline);
        const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

        otherGroups.forEach(g => {
          const row = document.createElement('div');
          row.className = 'assign-target-group-row';
          row.innerHTML = `
            <label class="assign-target-group-info">
              <input type="checkbox" class="assign-target-group-checkbox" data-copy-group-id="${g.id}">
              <div>
                <div class="assign-target-group-name">${escapeHtml(g.name)}</div>
                <div class="assign-target-group-sub">${g.students.length} студентов</div>
              </div>
            </label>
            <div class="assign-target-group-deadline-wrap">
              <span style="font-size: 0.72rem; color: var(--text-muted);">Дедлайн:</span>
              <input type="datetime-local" class="assign-target-group-deadline-input" data-copy-deadline-id="${g.id}" value="${iso}">
            </div>
          `;
          listContainer.appendChild(row);
        });
      }
    }

    openModal('modal-copy-assignment');
  }

  document.getElementById('form-copy-assignment')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!copyingAssignmentContext) return;

    const { assign } = copyingAssignmentContext;
    const checked = Array.from(document.querySelectorAll('#copy-assign-targets-list [data-copy-group-id]:checked'));

    if (checked.length === 0) {
      showToast('Выберите хотя бы одну целевую группу', 'warning');
      return;
    }

    let copiedCount = 0;
    checked.forEach(cb => {
      const gid = cb.getAttribute('data-copy-group-id');
      const targetGroup = (state.data.groups || []).find(g => g.id === gid);
      if (!targetGroup) return;

      const dlInput = document.querySelector(`#copy-assign-targets-list [data-copy-deadline-id="${gid}"]`);
      const customDlVal = dlInput ? dlInput.value : null;
      const groupDeadline = customDlVal ? new Date(customDlVal).toISOString() : assign.deadline;

      const cloneId = (assign.type === 'classwork' ? 'cw-' : 'hw-') + Date.now() + '-' + Math.floor(Math.random() * 1000);
      targetGroup.assignments.push({
        id: cloneId,
        type: assign.type,
        title: assign.title,
        description: assign.description,
        deadline: groupDeadline,
        videoUrl: assign.videoUrl,
        images: assign.images || (assign.image ? [assign.image] : null)
      });

      targetGroup.students.forEach(s => {
        s.grades[cloneId] = null;
      });
      copiedCount++;
    });

    saveData();
    closeModal('modal-copy-assignment');
    renderApp();
    showToast(`Задание успешно продублировано в ${copiedCount} групп!`, 'success');
  });

  document.getElementById('btn-assign-toggle-all-groups')?.addEventListener('click', () => {
    const checkboxes = Array.from(document.querySelectorAll('#assign-target-groups-list .assign-target-group-checkbox'));
    if (checkboxes.length === 0) return;
    const allChecked = checkboxes.every(cb => cb.checked);
    checkboxes.forEach(cb => { cb.checked = !allChecked; });
    const btn = document.getElementById('btn-assign-toggle-all-groups');
    if (btn) btn.textContent = allChecked ? 'Выбрать все' : 'Снять выбор';
  });

  document.getElementById('btn-copy-toggle-all-groups')?.addEventListener('click', () => {
    const checkboxes = Array.from(document.querySelectorAll('#copy-assign-targets-list [data-copy-group-id]'));
    if (checkboxes.length === 0) return;
    const allChecked = checkboxes.every(cb => cb.checked);
    checkboxes.forEach(cb => { cb.checked = !allChecked; });
    const btn = document.getElementById('btn-copy-toggle-all-groups');
    if (btn) btn.textContent = allChecked ? 'Выбрать все' : 'Снять выбор';
  });

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

  function openGitHubSettingsModal() {
    const ownerInput = document.getElementById('github-owner-input');
    const repoInput = document.getElementById('github-repo-input');
    const branchInput = document.getElementById('github-branch-input');
    const tokenInput = document.getElementById('github-token-input');

    if (ownerInput) ownerInput.value = state.githubSettings.owner || '';
    if (repoInput) repoInput.value = state.githubSettings.repo || '';
    if (branchInput) branchInput.value = state.githubSettings.branch || 'main';
    if (tokenInput) tokenInput.value = state.githubSettings.token || '';

    updateGitHubStatusCard(state.githubSettings);
    openModal('modal-github-settings');
  }

  async function handleTestGitHub() {
    const owner = document.getElementById('github-owner-input').value.trim();
    const repo = document.getElementById('github-repo-input').value.trim();
    const token = document.getElementById('github-token-input').value.trim();
    await testGitHubConnection({ owner, repo, token });
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
      if (typeof optimizeRegisterDataImages === 'function') {
        showToast('Оптимизация базы данных...', 'info');
        const wasOptimized = await optimizeRegisterDataImages(state.data);
        if (wasOptimized) {
          saveData();
        }
      }

      showToast('Создание коммита на GitHub...', 'info');

      const jsonContent = JSON.stringify(state.data, null, 2);
      const jsContent = `/**\n * Автоматически сгенерированные данные электронного журнала\n * Экспортировано: ${new Date().toISOString()}\n */\nwindow.DEFAULT_REGISTER_DATA = ${JSON.stringify(state.data, null, 2)};\n`;

      const timeStr = new Date().toLocaleString('ru-RU');
      const commitMsg = `Обновление успеваемости (из журнала) — ${timeStr}`;

      await commitMultipleFilesToGitHub({
        owner,
        repo,
        branch: branch || 'main',
        token,
        files: [
          { path: 'data.json', contentStr: jsonContent },
          { path: 'data.js', contentStr: jsContent }
        ],
        commitMessage: commitMsg
      });

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
    // Копирование задания в другие группы
    document.querySelectorAll('[data-copy-assign]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openCopyAssignmentModal(btn.dataset.copyAssign);
      };
    });

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
    document.getElementById('btn-test-github-conn')?.addEventListener('click', handleTestGitHub);

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

    // Обработка прикрепления картинок к заданию
    const assignFileInput = document.getElementById('assign-image-file');
    const assignUrlInput = document.getElementById('assign-image-url');
    const btnAddImageUrl = document.getElementById('btn-add-image-url');

    function addImageFromUrl() {
      if (!assignUrlInput) return;
      const val = assignUrlInput.value.trim();
      if (!val) return;
      if (!state.editingAssignmentImages.includes(val)) {
        state.editingAssignmentImages.push(val);
        updateImageEditorPreview();
      }
      assignUrlInput.value = '';
    }

    btnAddImageUrl?.addEventListener('click', addImageFromUrl);
    assignUrlInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addImageFromUrl();
      }
    });

    assignFileInput?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      const validFiles = files.filter(f => f.type.startsWith('image/'));
      if (validFiles.length < files.length) {
        showToast('Некоторые выбранные файлы не являются изображениями', 'warning');
      }

      if (validFiles.length === 0) return;

      // Сжимаем и масштабируем каждую картинку (Canvas) для экономии места
      const compressPromises = validFiles.map(file => {
        if (compressImageFile) {
          return compressImageFile(file);
        }
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (re) => resolve(re.target.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
      });

      Promise.all(compressPromises).then(results => {
        results.filter(Boolean).forEach(res => {
          state.editingAssignmentImages.push(res);
        });
        updateImageEditorPreview();
        assignFileInput.value = '';
      });
    });

    // Слушатели карусели и закрытия просмотрщика картинок (Lightbox)
    document.getElementById('lightbox-close-btn')?.addEventListener('click', closeLightbox);
    document.getElementById('lightbox-prev-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxPrev();
    });
    document.getElementById('lightbox-next-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxNext();
    });

    document.getElementById('modal-image-lightbox')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-image-lightbox' || e.target.classList.contains('lightbox-overlay')) {
        closeLightbox();
      }
    });

    window.addEventListener('keydown', (e) => {
      const lightbox = document.getElementById('modal-image-lightbox');
      const isLightboxActive = lightbox && lightbox.style.display === 'flex';

      if (e.key === 'Escape') {
        if (isLightboxActive) {
          closeLightbox();
        } else {
          const activeModals = document.querySelectorAll('.modal-overlay.active');
          if (activeModals.length > 0) {
            activeModals[activeModals.length - 1].classList.remove('active');
            updateModalBodyLock();
          }
        }
      } else if (isLightboxActive && e.key === 'ArrowRight') {
        lightboxNext();
      } else if (isLightboxActive && e.key === 'ArrowLeft') {
        lightboxPrev();
      }
    });

    // Свайп-жесты для мобильных устройств (карусель в полноэкранном режиме)
    let touchStartX = 0;
    let touchStartY = 0;
    const lightboxEl = document.getElementById('modal-image-lightbox');
    lightboxEl?.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length > 0) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    lightboxEl?.addEventListener('touchend', (e) => {
      if (e.changedTouches && e.changedTouches.length > 0) {
        const diffX = e.changedTouches[0].clientX - touchStartX;
        const diffY = e.changedTouches[0].clientY - touchStartY;
        // Порог свайпа по горизонтали (более 40px и преимущественно по горизонтали)
        if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY)) {
          if (diffX < 0) {
            lightboxNext();
          } else {
            lightboxPrev();
          }
        }
      }
    }, { passive: true });

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
        if (idbDelete) {
          idbDelete(STORAGE_KEY);
        }
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
