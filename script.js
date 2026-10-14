/* Секретное досье: автономное приложение без зависимостей и сервера. */
(() => {
  'use strict';

  const STORAGE_KEY = 'secret-dossier-nominees-v1';
  const DRAFT_KEY = 'secret-dossier-editor-drafts-v1';
  const PRESENTATION_KEY = 'secret-dossier-presentation-v1';
  const PRESENTATION_HASH = '#dossier-state=';
  const LAUREATES_MIGRATION_KEY = 'secret-dossier-laureates-v1';
  const NEW_DRAFT_KEY = '__new__';
  const DEFAULT_AWARD_REASON = 'За профессионализм, преданность делу и вклад в жизнь нашего института.';
  const PAGE_SIZE = 12;
  const MAX_PROFILES = 150;
  const MAX_REASON_CHARS = 700;
  const MAX_PHOTO_CHARS = 78000;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const $ = (id) => document.getElementById(id);

  const LEGACY_DEMO = [
    { id: 'demo-anna', name: 'Анна Сергеевна Иванова', department: 'Научная лаборатория', position: 'Научный сотрудник', power: 'Способность превращать самые смелые гипотезы в научные результаты.', traits: ['Научная любознательность: безграничная.', 'Настойчивость: 100%.', 'Способность находить ответы: подтверждена экспериментально.'], award: 'Почётная грамота', awardReason: 'За выдающиеся достижения в научных исследованиях и преданность делу.', photo: null },
    { id: 'demo-sergey', name: 'Сергей Петрович Ковалёв', department: 'Инженерно-техническая служба', position: 'Инженер', power: 'Умение возвращать к жизни технику, которую остальные уже мысленно списали.', traits: ['Устойчивость к техническим неожиданностям: высокая.', 'Изобретательность: практически неисчерпаемая.', 'Репутация среди оборудования: легендарная.'], award: 'Благодарность', awardReason: 'За мастерство, изобретательность и неизменную помощь коллегам.', photo: null },
    { id: 'demo-elena', name: 'Елена Викторовна Смирнова', department: 'Административный отдел', position: 'Специалист', power: 'Умение одновременно решать десять задач и сохранять абсолютное спокойствие.', traits: ['Многозадачность: феноменальная.', 'Организованность: эталонная.', 'Соблюдение сроков: подтверждено многолетними наблюдениями.'], award: 'Почётная грамота', awardReason: 'За безупречную организацию работы и заботу о каждом сотруднике.', photo: null }
  ];
  const LAUREATES = (Array.isArray(window.LAUREATES) ? window.LAUREATES : []).map((person) => ({
    ...person, traits: [...person.traits], photo: null
  }));

  const state = {
    nominees: LAUREATES.map((person) => ({ ...person, traits: [...person.traits] })),
    screen: 'start', index: 0, stage: 'secret', galleryPage: 0, presentationReady: false, presentationWarningShown: false,
    revealed: new Set(), selectedId: null, selectedKey: null, draftPhoto: null, drafts: Object.create(null), editorBaseline: null, editorVersion: 0, autosaveTimer: null,
    sound: false, audioContext: null, scanFrame: null,
    controlsTimer: null, toastTimer: null
  };

  function notice(message, error = false) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, 5500);
  }

  function validText(value, max, label) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw new Error(`${label}: укажите текст длиной до ${max} символов.`);
    }
    return value.trim();
  }

  function validateNominees(items) {
    if (!Array.isArray(items) || items.length > MAX_PROFILES) {
      throw new Error(`Файл должен содержать список не более ${MAX_PROFILES} сотрудников.`);
    }
    const ids = new Set();
    return items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Досье № ${index + 1}: неверный формат.`);
      const id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ? item.id : makeId();
      if (ids.has(id)) throw new Error(`Досье № ${index + 1}: повторяется идентификатор.`);
      ids.add(id);
      if (!Array.isArray(item.traits) || item.traits.length !== 3) throw new Error(`Досье № ${index + 1}: нужны ровно три характеристики.`);
      const photo = item.photo == null || item.photo === '' ? null : item.photo;
      if (photo !== null && (typeof photo !== 'string' || photo.length > MAX_PHOTO_CHARS || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo))) {
        throw new Error(`Досье № ${index + 1}: фотография имеет неверный формат или слишком велика.`);
      }
      return {
        id,
        name: validText(item.name, 120, `Досье № ${index + 1}, ФИО`),
        position: validText(item.position, 120, `Досье № ${index + 1}, должность`),
        department: validText(item.department, 120, `Досье № ${index + 1}, подразделение`),
        power: validText(item.power, 300, `Досье № ${index + 1}, суперсила`),
        traits: item.traits.map((trait, traitIndex) => validText(trait, 180, `Досье № ${index + 1}, характеристика ${traitIndex + 1}`)),
        award: validText(item.award, 120, `Досье № ${index + 1}, награда`),
        awardReason: item.awardReason == null ? DEFAULT_AWARD_REASON : validText(item.awardReason, MAX_REASON_CHARS, `Досье № ${index + 1}, причина награждения`),
        photo
      };
    });
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `person-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeDraft(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверный формат черновика.');
    const fields = ['name', 'position', 'department', 'power', 'award', 'awardReason'];
    const draft = { id: key === NEW_DRAFT_KEY ? value.id : key };
    if (typeof draft.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(draft.id)) throw new Error('Неверный идентификатор черновика.');
    for (const field of fields) {
      const content = field === 'awardReason' && value[field] == null ? DEFAULT_AWARD_REASON : value[field];
      if (typeof content !== 'string' || content.length > (field === 'power' ? 300 : field === 'awardReason' ? MAX_REASON_CHARS : 120)) throw new Error('Повреждены поля черновика.');
      draft[field] = content;
    }
    if (!Array.isArray(value.traits) || value.traits.length !== 3 || value.traits.some((trait) => typeof trait !== 'string' || trait.length > 180)) throw new Error('Повреждены характеристики черновика.');
    draft.traits = [...value.traits];
    draft.photo = value.photo == null ? null : value.photo;
    if (draft.photo !== null && (typeof draft.photo !== 'string' || draft.photo.length > MAX_PHOTO_CHARS || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(draft.photo))) throw new Error('Повреждена фотография черновика.');
    return draft;
  }

  function loadDrafts() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('Неверный формат сохранённых черновиков.');
      for (const [key, value] of Object.entries(saved.entries)) {
        if (key === NEW_DRAFT_KEY || state.nominees.some((person) => person.id === key)) state.drafts[key] = normalizeDraft(value, key);
      }
      if (saved.selectedKey === NEW_DRAFT_KEY || state.nominees.some((person) => person.id === saved.selectedKey)) state.selectedKey = saved.selectedKey;
    } catch (error) {
      setTimeout(() => notice(`Черновики не прочитаны: ${error.message}`, true), 100);
    }
  }

  function writeDrafts() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, selectedKey: state.selectedKey, entries: state.drafts }));
  }

  function setSaveStatus(message, error = false) {
    $('saveStatus').textContent = message;
    $('saveStatus').classList.toggle('save-error', error);
  }

  function isCompleteDraft(draft) {
    return ['name', 'position', 'department', 'power', 'award', 'awardReason'].every((key) => draft[key].trim()) && draft.traits.every((trait) => trait.trim());
  }

  function commitCompleteDrafts() {
    clearTimeout(state.autosaveTimer);
    const next = [...state.nominees];
    const completed = [];
    let newId = null;
    for (const [key, draft] of Object.entries(state.drafts)) {
      if (!isCompleteDraft(draft)) continue;
      let person;
      try { person = validateNominees([draft])[0]; }
      catch (error) { setSaveStatus('ОШИБКА СОХРАНЕНИЯ', true); notice(error.message, true); return false; }
      const index = next.findIndex((item) => item.id === person.id);
      if (key === NEW_DRAFT_KEY) {
        if (index >= 0) next[index] = person;
        else next.push(person);
        newId = person.id;
      } else if (index >= 0) next[index] = person;
      else continue;
      completed.push(key);
    }
    if (!completed.length) return true;
    if (!saveData(next)) { setSaveStatus('ОШИБКА СОХРАНЕНИЯ', true); return false; }
    for (const key of completed) delete state.drafts[key];
    if (newId && state.selectedKey === NEW_DRAFT_KEY) {
      state.selectedId = newId;
      state.selectedKey = newId;
      $('formTitle').textContent = 'РЕДАКТИРОВАТЬ ДОСЬЕ';
      $('formIndex').textContent = `ОБЪЕКТ / ${String(state.nominees.findIndex((item) => item.id === newId) + 1).padStart(3, '0')}`;
    }
    try { writeDrafts(); }
    catch (error) { notice(`Досье сохранено, но черновик не очищен: ${error.message}`, true); }
    if (state.screen === 'editor') {
      renderList();
      const currentDraft = state.drafts[state.selectedId ?? NEW_DRAFT_KEY];
      setSaveStatus(currentDraft ? (isCompleteDraft(currentDraft) ? 'СОХРАНЯЕТСЯ...' : 'ЧЕРНОВИК СОХРАНЁН') : 'СОХРАНЕНО АВТОМАТИЧЕСКИ');
    }
    return true;
  }

  function captureDraft() {
    const key = state.selectedId ?? NEW_DRAFT_KEY;
    return {
      id: key === NEW_DRAFT_KEY ? (state.drafts[key]?.id ?? makeId()) : key,
      name: $('fieldName').value, position: $('fieldPosition').value,
      department: $('fieldDepartment').value, power: $('fieldPower').value,
      traits: [1, 2, 3].map((number) => $(`fieldTrait${number}`).value),
      award: $('fieldAward').value, awardReason: $('fieldAwardReason').value, photo: state.draftPhoto
    };
  }

  function saveDraft() {
    const key = state.selectedId ?? NEW_DRAFT_KEY;
    const draft = captureDraft();
    state.drafts[key] = draft;
    state.selectedKey = key;
    try {
      writeDrafts();
      setSaveStatus(isCompleteDraft(draft) ? 'СОХРАНЯЕТСЯ...' : 'ЧЕРНОВИК СОХРАНЁН');
      if (isCompleteDraft(draft)) {
        clearTimeout(state.autosaveTimer);
        state.autosaveTimer = setTimeout(commitCompleteDrafts, 350);
      }
    } catch (error) {
      setSaveStatus('ОШИБКА СОХРАНЕНИЯ', true);
      notice(`Черновик не сохранён: ${error.message}`, true);
    }
  }

  function discardDraft(key) {
    delete state.drafts[key];
    try { writeDrafts(); }
    catch (error) { notice(`Не удалось удалить черновик: ${error.message}`, true); }
  }

  function clearDrafts() {
    clearTimeout(state.autosaveTimer);
    state.drafts = Object.create(null);
    state.selectedKey = null;
    try { localStorage.removeItem(DRAFT_KEY); }
    catch (error) { notice(`Не удалось очистить черновики: ${error.message}`, true); }
  }

  function isUnchangedDemo(person) {
    const original = LEGACY_DEMO.find((item) => item.id === person.id);
    return !!original && ['name', 'position', 'department', 'power', 'award', 'photo'].every((field) => person[field] === original[field])
      && JSON.stringify(person.traits) === JSON.stringify(original.traits)
      && [original.awardReason, DEFAULT_AWARD_REASON].includes(person.awardReason);
  }

  function awardKey(person) {
    return `${person.name.toLocaleLowerCase('ru').replaceAll('ё', 'е')}|${person.award.toLocaleLowerCase('ru').replaceAll('ё', 'е')}`;
  }

  function mergeLaureates() {
    if (!LAUREATES.length) return notice('Не найден список лауреатов. Проверьте файл laureates.js.', true);
    try { if (localStorage.getItem(LAUREATES_MIGRATION_KEY) === '1') return; }
    catch (_) { /* Список всё равно отображается в текущей вкладке. */ }
    const retained = state.nominees.filter((person) => !isUnchangedDemo(person) || !!state.drafts[person.id]);
    const used = new Set();
    const ordered = LAUREATES.map((laureate) => {
      const existing = retained.find((person) => !used.has(person.id) && (person.id === laureate.id || awardKey(person) === awardKey(laureate)));
      if (existing) used.add(existing.id);
      return existing ?? laureate;
    });
    if (!saveData([...ordered, ...retained.filter((person) => !used.has(person.id))])) return;
    try { localStorage.setItem(LAUREATES_MIGRATION_KEY, '1'); }
    catch (error) { notice(`Не удалось отметить обновление списка: ${error.message}`, true); }
  }

  function loadData() {
    let dataReadError = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) state.nominees = validateNominees(JSON.parse(raw));
    } catch (error) {
      dataReadError = true;
      setTimeout(() => notice(`Сохранённые данные не прочитаны: ${error.message}. Показан список лауреатов.`, true), 100);
    }
    loadDrafts();
    commitCompleteDrafts();
    if (!dataReadError) mergeLaureates();
    updateCounts();
  }

  function saveData(next, successMessage) {
    try {
      const clean = validateNominees(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
      state.nominees = clean;
      const validIds = new Set(clean.map((person) => person.id));
      state.revealed = new Set([...state.revealed].filter((id) => validIds.has(id)));
      state.index = Math.min(state.index, Math.max(0, clean.length - 1));
      updateCounts();
      savePresentation();
      if (successMessage) notice(successMessage);
      return true;
    } catch (error) {
      const detail = error.name === 'QuotaExceededError' ? 'Хранилище браузера заполнено. Удалите лишние фотографии или экспортируйте данные в JSON.' : error.message;
      notice(`Не удалось сохранить: ${detail}`, true);
      return false;
    }
  }

  function updateCounts() {
    const count = String(state.nominees.length).padStart(2, '0');
    $('startCount').textContent = count;
    $('editorCount').textContent = count;
    $('startButton').disabled = state.nominees.length === 0;
  }

  function savePresentation() {
    if (!state.presentationReady) return;
    const snapshot = {
      version: 1,
      screen: state.screen,
      nomineeId: state.nominees[state.index]?.id ?? null,
      index: state.index,
      stage: state.stage === 'scanning' ? 'secret' : state.stage,
      revealedIds: [...state.revealed],
      galleryPage: state.galleryPage
    };
    const serialized = JSON.stringify(snapshot);
    const hash = `${PRESENTATION_HASH}${encodeURIComponent(serialized)}`;
    let hashSaved = location.hash === hash;
    if (!hashSaved) {
      try { history.replaceState(history.state, '', hash); hashSaved = true; }
      catch (_) {
        try { location.hash = hash; hashSaved = true; }
        catch (_) { /* Сообщение об ошибке показывается ниже. */ }
      }
    }
    try { localStorage.setItem(PRESENTATION_KEY, serialized); }
    catch (error) {
      if (!state.presentationWarningShown) {
        notice(hashSaved
          ? 'LocalStorage недоступен: при обновлении этой вкладки ход церемонии сохранится в её адресе. Не закрывайте вкладку.'
          : `Не удалось сохранить ход церемонии: ${error.message}`, true);
        state.presentationWarningShown = true;
      }
    }
  }

  function restorePresentation() {
    let saved = null;
    if (location.hash.startsWith(PRESENTATION_HASH)) {
      try { saved = JSON.parse(decodeURIComponent(location.hash.slice(PRESENTATION_HASH.length))); }
      catch (_) { /* Если адрес повреждён, проверяем LocalStorage. */ }
    }
    try {
      if (!saved || saved.version !== 1) {
        const raw = localStorage.getItem(PRESENTATION_KEY);
        if (raw) saved = JSON.parse(raw);
      }
    } catch (error) {
      if (!saved || saved.version !== 1) notice(`Не удалось восстановить ход церемонии: ${error.message}`, true);
    }
    state.presentationReady = true;
    if (!saved || saved.version !== 1 || !state.nominees.length) return;
    const validIds = new Set(state.nominees.map((person) => person.id));
    state.revealed = new Set(Array.isArray(saved.revealedIds) ? saved.revealedIds.filter((id) => validIds.has(id)) : []);
    const byId = state.nominees.findIndex((person) => person.id === saved.nomineeId);
    if (byId >= 0) state.index = byId;
    else if (saved.nomineeId) state.index = 0;
    else state.index = Number.isInteger(saved.index) ? Math.min(Math.max(0, saved.index), state.nominees.length - 1) : 0;
    state.stage = saved.stage === 'revealed' && state.revealed.has(state.nominees[state.index].id) ? 'revealed' : 'secret';
    state.galleryPage = Number.isInteger(saved.galleryPage) ? Math.max(0, saved.galleryPage) : 0;
    if (saved.screen === 'ceremony') {
      showScreen('ceremony');
      renderCeremony();
    } else if (saved.screen === 'final') {
      showScreen('final');
      renderGallery();
    } else if (saved.screen === 'editor') openEditor();
  }

  function showScreen(screen) {
    state.screen = screen;
    for (const name of ['start', 'ceremony', 'final', 'editor']) $(`${name}Screen`).hidden = name !== screen;
    $('headerStatus').textContent = { start: 'ДОСТУП ОТКРЫТ', ceremony: 'ПРОТОКОЛ АКТИВЕН', final: 'АРХИВ РАСКРЫТ', editor: 'РЕЖИМ РЕДАКТОРА' }[screen];
    window.scrollTo(0, 0);
    if (screen === 'ceremony') showControls();
    savePresentation();
  }

  function openStart() {
    if (state.stage === 'scanning') return;
    if (state.screen === 'editor') commitCompleteDrafts();
    showScreen('start');
  }

  function startCeremony() {
    if (!state.nominees.length) return notice('Добавьте хотя бы одного сотрудника в редакторе.', true);
    state.index = 0;
    state.revealed.clear();
    state.stage = 'secret';
    showScreen('ceremony');
    renderCeremony();
  }

  function createTraitCard(value, index) {
    const card = document.createElement('div');
    card.className = 'trait-card';
    const number = document.createElement('small');
    number.textContent = `0${index + 1} / ПРИЗНАК`;
    const description = document.createElement('span');
    description.textContent = value;
    card.append(number, description);
    return card;
  }

  function renderCeremony() {
    const person = state.nominees[state.index];
    if (!person) return showFinal();
    const revealed = state.stage === 'revealed';
    $('caseNumber').textContent = `№ ${String(state.index + 1).padStart(3, '0')}`;
    $('casePosition').textContent = `${String(state.index + 1).padStart(2, '0')} / ${String(state.nominees.length).padStart(2, '0')}`;
    $('portraitSerial').textContent = `ОБЪЕКТ / ${String(state.index + 1).padStart(3, '0')}`;
    $('secretContent').hidden = revealed;
    $('revealedContent').hidden = !revealed;
    $('ceremonyScreen').classList.toggle('showing-reveal', revealed);
    $('portraitFrame').classList.toggle('is-revealed', revealed);
    $('scanOverlay').hidden = true;
    $('restartButton').disabled = !revealed;
    $('prevButton').disabled = state.index === 0;
    $('mainActionLabel').textContent = revealed ? (state.index === state.nominees.length - 1 ? 'ФИНАЛ' : 'СЛЕДУЮЩЕЕ ДОСЬЕ') : 'РАССЕКРЕТИТЬ';
    $('nextButton').querySelector('span').textContent = state.index === state.nominees.length - 1 ? 'ФИНАЛ' : 'ДАЛЕЕ';
    if (revealed) {
      $('revealedName').textContent = person.name;
      $('revealedPosition').textContent = person.position;
      $('revealedDepartment').textContent = person.department;
      $('revealedAward').textContent = person.award;
      $('revealedAwardReason').textContent = person.awardReason;
      $('revealedAwardReason').classList.toggle('is-long', person.awardReason.length > 95);
      $('revealedAwardReason').classList.toggle('is-very-long', person.awardReason.length > 155);
      $('revealedAwardReason').classList.toggle('is-detailed', person.awardReason.length > 260);
      $('revealedAwardReason').classList.toggle('is-extensive', person.awardReason.length > 360);
      $('ceremonyScreen').classList.toggle('detailed-award', person.awardReason.length > 260);
      $('portraitLabel').textContent = 'ЛИЧНОСТЬ УСТАНОВЛЕНА';
      $('portraitPhoto').hidden = !person.photo;
      $('portraitSilhouette').hidden = !!person.photo;
      if (person.photo) { $('portraitPhoto').src = person.photo; $('portraitPhoto').alt = `Фотография: ${person.name}`; }
      else { $('portraitPhoto').removeAttribute('src'); $('portraitPhoto').alt = ''; }
    } else {
      $('ceremonyScreen').classList.remove('detailed-award');
      $('secretPower').textContent = person.power;
      $('traitCards').replaceChildren(...person.traits.map(createTraitCard));
      $('revealedName').textContent = '';
      $('revealedPosition').textContent = '';
      $('revealedDepartment').textContent = '';
      $('revealedAward').textContent = '';
      $('revealedAwardReason').textContent = '';
      $('portraitLabel').textContent = 'ДАННЫЕ СКРЫТЫ';
      $('portraitPhoto').hidden = true;
      $('portraitPhoto').removeAttribute('src');
      $('portraitPhoto').alt = '';
      $('portraitSilhouette').hidden = false;
    }
  }

  function move(delta) {
    if (state.stage === 'scanning') return;
    const next = state.index + delta;
    if (next < 0) return;
    if (next >= state.nominees.length) return showFinal();
    state.index = next;
    state.stage = state.revealed.has(state.nominees[next].id) ? 'revealed' : 'secret';
    renderCeremony();
    showControls();
    savePresentation();
  }

  function mainAction() {
    if (state.stage === 'scanning') return;
    if (state.stage === 'secret') beginReveal();
    else move(1);
  }

  function beginReveal() {
    if (state.screen !== 'ceremony' || state.stage !== 'secret') return;
    state.stage = 'scanning';
    $('scanOverlay').hidden = false;
    $('scanMessage').textContent = 'ЗАПУСК ПРОЦЕДУРЫ ИДЕНТИФИКАЦИИ';
    $('scanPercent').textContent = '00%';
    $('scanProgress').style.width = '0%';
    playScanSound();
    const duration = reducedMotion.matches ? 300 : 2550;
    const started = performance.now();
    function animate(now) {
      const progress = Math.min(1, (now - started) / duration);
      const percent = Math.round(progress * 100);
      $('scanProgress').style.width = `${percent}%`;
      $('scanPercent').textContent = `${String(percent).padStart(2, '0')}%`;
      if (progress > .84) $('scanMessage').textContent = 'ЛИЧНОСТЬ УСТАНОВЛЕНА';
      else if (progress > .46) $('scanMessage').textContent = 'СОПОСТАВЛЕНИЕ ДАННЫХ...';
      if (progress < 1) state.scanFrame = requestAnimationFrame(animate);
      else finishReveal();
    }
    state.scanFrame = requestAnimationFrame(animate);
  }

  function finishReveal() {
    state.scanFrame = null;
    state.revealed.add(state.nominees[state.index].id);
    state.stage = 'revealed';
    renderCeremony();
    playSuccessSound();
    showControls();
    savePresentation();
  }

  function restartReveal() {
    if (state.screen !== 'ceremony' || state.stage !== 'revealed') return;
    state.revealed.delete(state.nominees[state.index].id);
    state.stage = 'secret';
    renderCeremony();
    savePresentation();
  }

  function showFinal() {
    state.galleryPage = 0;
    showScreen('final');
    renderGallery();
  }

  function silhouetteCopy() {
    const svg = $('portraitSilhouette').cloneNode(true);
    svg.removeAttribute('id');
    svg.hidden = false;
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function renderGallery() {
    const totalPages = Math.max(1, Math.ceil(state.nominees.length / PAGE_SIZE));
    state.galleryPage = Math.min(Math.max(0, state.galleryPage), totalPages - 1);
    $('galleryPageLabel').textContent = `${String(state.galleryPage + 1).padStart(2, '0')} / ${String(totalPages).padStart(2, '0')}`;
    $('galleryPrev').disabled = state.galleryPage === 0;
    $('galleryNext').disabled = state.galleryPage === totalPages - 1;
    const cards = state.nominees.slice(state.galleryPage * PAGE_SIZE, (state.galleryPage + 1) * PAGE_SIZE).map((person) => {
      const card = document.createElement('article');
      card.className = 'gallery-card';
      const portrait = document.createElement('div');
      portrait.className = 'gallery-photo';
      if (person.photo) {
        const image = document.createElement('img');
        image.src = person.photo;
        image.alt = `Фотография: ${person.name}`;
        portrait.append(image);
      } else portrait.append(silhouetteCopy());
      const name = document.createElement('strong');
      name.textContent = person.name;
      const award = document.createElement('small');
      award.textContent = person.award;
      card.append(portrait, name, award);
      return card;
    });
    $('finalGallery').replaceChildren(...cards);
  }

  function changeGalleryPage(delta) {
    const pages = Math.max(1, Math.ceil(state.nominees.length / PAGE_SIZE));
    const next = state.galleryPage + delta;
    if (next < 0 || next >= pages) return;
    state.galleryPage = next;
    renderGallery();
    savePresentation();
  }

  function showControls() {
    if (state.screen !== 'ceremony') return;
    $('ceremonyControls').classList.add('controls-visible');
    clearTimeout(state.controlsTimer);
    state.controlsTimer = setTimeout(() => {
      if (!$('ceremonyControls').matches(':focus-within')) $('ceremonyControls').classList.remove('controls-visible');
    }, 3500);
  }

  function toggleSound() {
    state.sound = !state.sound;
    $('soundButton').setAttribute('aria-pressed', String(state.sound));
    $('soundButton').setAttribute('aria-label', state.sound ? 'Выключить звук' : 'Включить звук');
    $('soundButton').textContent = state.sound ? '♪' : '♪̸';
    if (state.sound) {
      try { getAudioContext().resume(); }
      catch (error) { state.sound = false; notice('Звук недоступен в этом браузере.', true); }
    }
    showControls();
  }

  function getAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio API недоступен');
    if (!state.audioContext) state.audioContext = new AudioContextClass();
    return state.audioContext;
  }

  function tone(frequency, duration, delay = 0, volume = .025) {
    if (!state.sound) return;
    try {
      const context = getAudioContext();
      const start = context.currentTime + delay;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + .035);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + .02);
    } catch (_) { /* Звуковой эффект необязателен. */ }
  }

  function playScanSound() { tone(392, .34, 0, .016); tone(523, .36, .43, .018); tone(659, .42, .91, .018); }
  function playSuccessSound() { tone(523, .5, 0, .02); tone(659, .55, .1, .018); tone(784, .72, .22, .017); }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else throw new Error('Полноэкранный режим не поддерживается');
    } catch (error) { notice(`Не удалось включить полный экран: ${error.message}`, true); }
    showControls();
  }

  function openEditor() {
    showScreen('editor');
    const key = state.selectedKey;
    selectNominee(key === NEW_DRAFT_KEY ? null : (state.nominees.some((person) => person.id === key) ? key : state.nominees[0]?.id ?? null));
  }

  function renderList() {
    $('editorCount').textContent = String(state.nominees.length).padStart(2, '0');
    const rows = state.nominees.map((person, index) => {
      const row = document.createElement('div');
      row.className = `list-row${person.id === state.selectedId ? ' selected' : ''}`;
      const main = document.createElement('button');
      main.className = 'list-main';
      main.type = 'button';
      const number = document.createElement('span');
      number.className = 'list-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'list-name';
      name.textContent = person.name;
      const award = document.createElement('small');
      award.className = 'list-award';
      award.textContent = person.award;
      const identity = document.createElement('span');
      identity.className = 'list-identity';
      identity.append(name, award);
      main.append(number, identity);
      main.addEventListener('click', () => selectNominee(person.id));
      const tools = document.createElement('div');
      tools.className = 'list-tools';
      for (const [symbol, label, action, disabled] of [
        ['↑', 'Переместить выше', () => reorder(index, -1), index === 0],
        ['↓', 'Переместить ниже', () => reorder(index, 1), index === state.nominees.length - 1],
        ['×', 'Удалить', () => deleteNominee(person.id), false]
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = symbol;
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${person.name}`);
        button.disabled = disabled;
        if (symbol === '×') button.className = 'delete-tool';
        button.addEventListener('click', action);
        tools.append(button);
      }
      row.append(main, tools);
      return row;
    });
    $('nomineeList').replaceChildren(...rows);
  }

  function selectNominee(id) {
    const person = state.nominees.find((item) => item.id === id);
    const key = person?.id ?? NEW_DRAFT_KEY;
    const draft = state.drafts[key];
    state.editorVersion++;
    state.selectedId = person?.id ?? null;
    state.selectedKey = key;
    state.editorBaseline = person ? { ...person, traits: [...person.traits] } : null;
    state.draftPhoto = draft ? draft.photo : person?.photo ?? null;
    $('nomineeForm').reset();
    $('formTitle').textContent = person ? 'РЕДАКТИРОВАТЬ ДОСЬЕ' : 'НОВОЕ ДОСЬЕ';
    $('formIndex').textContent = person ? `ОБЪЕКТ / ${String(state.nominees.indexOf(person) + 1).padStart(3, '0')}` : 'НОВЫЙ ОБЪЕКТ';
    for (const [fieldName, field] of [['name', 'fieldName'], ['position', 'fieldPosition'], ['department', 'fieldDepartment'], ['power', 'fieldPower'], ['award', 'fieldAward'], ['awardReason', 'fieldAwardReason']]) $(field).value = draft ? draft[fieldName] : person?.[fieldName] ?? '';
    for (let i = 0; i < 3; i++) $(`fieldTrait${i + 1}`).value = draft ? draft.traits[i] : person?.traits[i] ?? '';
    updatePhotoPreview();
    renderList();
    setSaveStatus(draft ? (isCompleteDraft(draft) ? 'СОХРАНЯЕТСЯ...' : 'ЧЕРНОВИК СОХРАНЁН') : 'АВТОСОХРАНЕНИЕ ВКЛЮЧЕНО');
    try { writeDrafts(); }
    catch (error) { setSaveStatus('ОШИБКА СОХРАНЕНИЯ', true); notice(`Не удалось сохранить выбор досье: ${error.message}`, true); }
  }

  function updatePhotoPreview() {
    const preview = $('editorPhotoPreview');
    if (state.draftPhoto) {
      const image = document.createElement('img');
      image.src = state.draftPhoto;
      image.alt = 'Предпросмотр фотографии';
      preview.replaceChildren(image);
    } else {
      const symbol = document.createElement('span');
      symbol.textContent = '◎';
      preview.replaceChildren(symbol);
    }
    $('removePhotoButton').hidden = !state.draftPhoto;
  }

  function saveForm(event) {
    event.preventDefault();
    const form = $('nomineeForm');
    if (!form.reportValidity()) return;
    try {
      const previous = state.nominees.find((item) => item.id === state.selectedId);
      const key = state.selectedId ?? NEW_DRAFT_KEY;
      const person = {
        id: previous?.id ?? state.drafts[NEW_DRAFT_KEY]?.id ?? makeId(),
        name: validText($('fieldName').value, 120, 'ФИО'),
        position: validText($('fieldPosition').value, 120, 'Должность'),
        department: validText($('fieldDepartment').value, 120, 'Подразделение'),
        power: validText($('fieldPower').value, 300, 'Суперсила'),
        traits: [1, 2, 3].map((number) => validText($(`fieldTrait${number}`).value, 180, `Характеристика ${number}`)),
        award: validText($('fieldAward').value, 120, 'Награда'),
        awardReason: validText($('fieldAwardReason').value, MAX_REASON_CHARS, 'Причина награждения'),
        photo: state.draftPhoto
      };
      const next = [...state.nominees];
      if (previous) next[next.indexOf(previous)] = person;
      else {
        if (next.length >= MAX_PROFILES) throw new Error(`Можно добавить не более ${MAX_PROFILES} сотрудников.`);
        next.push(person);
      }
      if (saveData(next, previous ? 'Досье обновлено.' : 'Досье добавлено.')) {
        discardDraft(key);
        selectNominee(person.id);
      }
    } catch (error) { notice(error.message, true); }
  }

  function cancelEdit() {
    clearTimeout(state.autosaveTimer);
    const id = state.selectedId;
    const baseline = state.editorBaseline;
    const current = state.nominees.find((person) => person.id === id);
    if (baseline && current && JSON.stringify(baseline) !== JSON.stringify(current)) {
      const next = state.nominees.map((person) => person.id === id ? baseline : person);
      if (!saveData(next)) return;
    } else if (!baseline && current) {
      if (!saveData(state.nominees.filter((person) => person.id !== id))) return;
    }
    discardDraft(id ?? NEW_DRAFT_KEY);
    if (!baseline && id) discardDraft(NEW_DRAFT_KEY);
    selectNominee(baseline?.id ?? state.nominees[0]?.id ?? null);
  }

  function reorder(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.nominees.length) return;
    const next = [...state.nominees];
    [next[index], next[target]] = [next[target], next[index]];
    if (saveData(next, 'Порядок сотрудников изменён.')) selectNominee(state.selectedId);
  }

  function deleteNominee(id) {
    const person = state.nominees.find((item) => item.id === id);
    if (!person || !window.confirm(`Удалить досье «${person.name}»?`)) return;
    const next = state.nominees.filter((item) => item.id !== id);
    if (saveData(next, 'Досье удалено.')) {
      discardDraft(id);
      selectNominee(next[0]?.id ?? null);
    }
  }

  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return reject(new Error('Выберите файл JPG, PNG или WebP.'));
      if (file.size > 12 * 1024 * 1024) return reject(new Error('Фотография должна быть меньше 12 МБ.'));
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas недоступен');
          const crop = Math.min(image.naturalWidth, image.naturalHeight);
          const sourceX = (image.naturalWidth - crop) / 2;
          const sourceY = (image.naturalHeight - crop) / 2;
          let result = '';
          for (const [size, quality] of [[560, .76], [500, .68], [440, .60], [380, .54], [320, .48], [280, .42]]) {
            canvas.width = size;
            canvas.height = size;
            context.fillStyle = '#122b36';
            context.fillRect(0, 0, size, size);
            context.drawImage(image, sourceX, sourceY, crop, crop, 0, 0, size, size);
            result = canvas.toDataURL('image/jpeg', quality);
            if (result.length <= 72000) break;
          }
          if (result.length > MAX_PHOTO_CHARS) throw new Error('Не удалось достаточно уменьшить фотографию. Выберите другое изображение.');
          resolve(result);
        } catch (error) { reject(error); }
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать изображение.')); };
      image.src = url;
    });
  }

  async function onPhotoSelected(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const version = state.editorVersion;
    try {
      const photo = await resizePhoto(file);
      if (version !== state.editorVersion) return;
      state.draftPhoto = photo;
      updatePhotoPreview();
      saveDraft();
      notice('Фотография добавлена в автосохранение.');
    } catch (error) { notice(error.message, true); }
  }

  function exportData() {
    commitCompleteDrafts();
    const content = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), nominees: state.nominees }, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sekretnoe-dosie-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice('Резервная копия JSON подготовлена для загрузки.');
  }

  async function checkImportedPhotos(items) {
    await Promise.all(items.filter((item) => item.photo).map((item) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => image.naturalWidth && image.naturalHeight ? resolve() : reject(new Error(`Не удалось прочитать фотографию: ${item.name}.`));
      image.onerror = () => reject(new Error(`Повреждена фотография: ${item.name}.`));
      image.src = item.photo;
    })));
  }

  async function importData(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('JSON-файл слишком велик (более 8 МБ).');
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) throw new Error('Неверная версия файла. Ожидается экспорт приложения (version: 1).');
      const imported = validateNominees(parsed.nominees);
      await checkImportedPhotos(imported);
      if (!window.confirm(`Заменить текущие ${state.nominees.length} досье на ${imported.length} из файла?`)) return;
      if (saveData(imported, `Импортировано досье: ${imported.length}.`)) {
        state.revealed.clear();
        state.index = 0;
        state.stage = 'secret';
        savePresentation();
        clearDrafts();
        selectNominee(imported[0]?.id ?? null);
      }
    } catch (error) { notice(`Импорт не выполнен: ${error.message}`, true); }
  }

  function restoreLaureates() {
    if (!window.confirm('Заменить текущие досье списком лауреатов из документа? Сначала экспортируйте данные, если хотите сохранить свои изменения.')) return;
    const originals = LAUREATES.map((person) => ({ ...person, traits: [...person.traits] }));
    if (saveData(originals, 'Список лауреатов восстановлен.')) {
      state.revealed.clear();
      state.index = 0;
      state.stage = 'secret';
      savePresentation();
      clearDrafts();
      selectNominee(originals[0]?.id ?? null);
    }
  }

  function keyboard(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    if (state.screen === 'editor') return;
    const key = event.key.toLowerCase();
    if (key === 'f') { event.preventDefault(); toggleFullscreen(); return; }
    if (key === 'm') { event.preventDefault(); toggleSound(); return; }
    if (state.screen === 'ceremony') {
      if (state.stage === 'scanning') { if ([' ', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault(); return; }
      if (key === ' ') { event.preventDefault(); mainAction(); }
      else if (key === 'arrowright') { event.preventDefault(); move(1); }
      else if (key === 'arrowleft') { event.preventDefault(); move(-1); }
      else if (key === 'r') { event.preventDefault(); restartReveal(); }
    } else if (state.screen === 'final') {
      if (key === 'arrowright') { event.preventDefault(); changeGalleryPage(1); }
      else if (key === 'arrowleft') { event.preventDefault(); changeGalleryPage(-1); }
    }
  }

  function startAmbient() {
    const canvas = $('ambientCanvas');
    const context = canvas.getContext('2d');
    if (!context || reducedMotion.matches) return;
    let width = 0, height = 0, dots = [];
    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      dots = Array.from({ length: Math.min(55, Math.floor(width / 27)) }, () => ({ x: Math.random() * width, y: Math.random() * height, radius: Math.random() * 1.8 + .5, drift: Math.random() * .25 + .06, phase: Math.random() * 6 }));
    }
    function draw() {
      context.clearRect(0, 0, width, height);
      const festive = state.screen === 'final' || (state.screen === 'ceremony' && state.stage === 'revealed');
      for (const [index, dot] of dots.entries()) {
        dot.y -= dot.drift;
        if (dot.y < -10) dot.y = height + 10;
        context.beginPath();
        const color = festive && index % 4 === 0 ? '233,197,124' : '115,221,215';
        context.fillStyle = `rgba(${color},${.12 + .15 * (1 + Math.sin(performance.now() / 1300 + dot.phase)) / 2})`;
        context.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        context.fill();
      }
      requestAnimationFrame(draw);
    }
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(draw);
  }

  function bind() {
    $('startButton').addEventListener('click', startCeremony);
    $('editorOpenButton').addEventListener('click', openEditor);
    $('editorHomeButton').addEventListener('click', openStart);
    $('homeButton').addEventListener('click', openStart);
    $('finalHomeButton').addEventListener('click', openStart);
    $('prevButton').addEventListener('click', () => move(-1));
    $('nextButton').addEventListener('click', () => move(1));
    $('mainActionButton').addEventListener('click', mainAction);
    $('restartButton').addEventListener('click', restartReveal);
    $('soundButton').addEventListener('click', toggleSound);
    $('fullscreenButton').addEventListener('click', toggleFullscreen);
    $('galleryPrev').addEventListener('click', () => changeGalleryPage(-1));
    $('galleryNext').addEventListener('click', () => changeGalleryPage(1));
    $('newNomineeButton').addEventListener('click', () => selectNominee(null));
    $('nomineeForm').addEventListener('submit', saveForm);
    $('nomineeForm').addEventListener('input', saveDraft);
    $('cancelEditButton').addEventListener('click', cancelEdit);
    $('photoFile').addEventListener('change', onPhotoSelected);
    $('removePhotoButton').addEventListener('click', () => { state.draftPhoto = null; updatePhotoPreview(); saveDraft(); });
    $('exportButton').addEventListener('click', exportData);
    $('importButton').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', importData);
    $('resetButton').addEventListener('click', restoreLaureates);
    document.addEventListener('keydown', keyboard);
    document.addEventListener('pointermove', showControls, { passive: true });
    document.addEventListener('pointerdown', showControls, { passive: true });
  }

  bind();
  loadData();
  restorePresentation();
  startAmbient();
})();
