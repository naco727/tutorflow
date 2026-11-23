'use strict';

let cloudSession = null;
let accountGeneration = 0;
let membershipWatch = null;
let cloudGateIdentity = null;
const cloud = TutorFlowCloud;

function mountCloudControls() {
  $('#authSetupNotice').after(Object.assign(document.createElement('div'), {innerHTML: `
    <div id="cloudGateActions" class="form-actions" hidden>
      <small id="cloudGateIdentity"></small>
      <button type="button" class="btn btn-secondary" id="verifyCloudEmail">寄出驗證信</button>
      <button type="button" class="btn btn-secondary" id="retryCloudAccount">重新檢查</button>
      <button type="button" class="btn btn-ghost" id="leaveCloudAccount">返回登入</button>
    </div>`}));
  $('#authLoginPanel').insertAdjacentHTML('afterbegin', `
    <div class="segmented" role="group" aria-label="登入方式">
      <button type="button" data-auth-method="phone" class="active" aria-pressed="true">手機驗證碼</button>
      <button type="button" data-auth-method="email" aria-pressed="false">Email＋密碼</button>
    </div>`);
  $('#phoneAuthForm').insertAdjacentHTML('afterend', `
    <form id="emailAuthForm" hidden>
      <div class="field"><label for="loginEmail">Email</label><input class="input" id="loginEmail" type="email" autocomplete="username" required></div>
      <div class="field"><label for="loginPassword">密碼</label><input class="input" id="loginPassword" type="password" autocomplete="current-password" required></div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" value="login">登入</button>
        <button type="submit" class="btn btn-secondary" value="register">申請帳號</button>
        <button type="submit" class="btn btn-ghost" value="reset" formnovalidate>忘記密碼</button>
      </div>
    </form>`);
  $('.topbar').insertAdjacentHTML('afterend', `
    <div class="cloud-sync-bar" aria-live="polite">
      <span id="cloudStatus"></span>
      <button type="button" class="btn btn-secondary btn-sm" id="retryCloudSave" hidden>重試同步</button>
      <button type="button" class="btn btn-secondary btn-sm" id="reloadCloudData" hidden>重新載入雲端</button>
    </div>`);
  $('#view-settings').insertAdjacentHTML('afterbegin', `
    <section class="card cloud-settings">
      <div class="section-head"><div><h2>雲端帳號</h2><p id="cloudAccount"></p></div>
        <button type="button" class="btn btn-ghost" id="logoutCloudSettings">登出</button>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="pendingDraft">匯出待同步草稿</button>
        <button type="button" class="btn btn-secondary" id="legacyBackup" hidden>下載此瀏覽器的舊資料</button>
      </div>
    </section>
    <section class="card cloud-settings" id="teacherAdmin" hidden>
      <div class="section-head"><h2>老師帳號管理</h2>
        <button type="button" class="btn btn-secondary" id="loadTeacherAdmin">載入帳號列表</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="toggleSignup" hidden></button>
      <div id="teacherAdminRows"></div>
    </section>
    <section class="card cloud-settings">
      <div class="section-head"><div><h2>私人預約</h2><p>記錄與學生約定的時段</p></div>
        <button type="button" class="btn btn-secondary" id="addPrivateBooking">新增預約</button>
      </div>
      <div id="privateBookingRows"></div>
    </section>`);
  $('#availabilityPreview').insertAdjacentHTML('beforebegin', '<p class="form-hint" id="availabilitySyncScope"></p>');
  const availabilityCard = $('.availability-card');
  availabilityCard.querySelector('h2').textContent = '空堂管理';
  availabilityCard.querySelector('.section-head p').textContent = '設定每週可授課時間，自動扣除已安排的課程。';
  $('[data-availability-action="preview"]').remove();
  $('#exportData').closest('.card').querySelector('.section-head p').textContent = '下載目前工作區，或預覽並匯入 TutorFlow JSON。';
}

function renderPrivateBookings() {
  const output = $('#privateBookingRows');
  if (!output || !data) return;
  const labels = {pending: '待確認', confirmed: '已確認', cancelled: '已取消'};
  output.replaceChildren();
  if (!data.bookings.length) output.textContent = '目前沒有私人預約。';
  const sorted = data.bookings.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  for (const booking of sorted) {
    const row = document.createElement('div');
    row.className = 'data-action';
    const label = document.createElement('span');
    label.textContent = `${booking.date} ${booking.start}–${booking.end} · ${booking.title} · ${labels[booking.status] || '待確認'}`;
    const edit = document.createElement('button');
    edit.className = 'btn btn-secondary btn-sm';
    edit.textContent = '編輯';
    edit.onclick = () => privateBookingForm(booking);
    row.append(label, edit);
    output.append(row);
  }
}

function privateBookingForm(booking = {}) {
  const session = cloudSession;
  if (!session) return;
  openModal(`<div class="modal-head"><h2>${booking.id ? '編輯私人預約' : '新增私人預約'}</h2><button class="close-btn" data-close aria-label="關閉">×</button></div>
    <form class="form-grid" id="privateBookingForm">
      <div class="field full"><label for="bookingTitle">預約名稱</label><input class="input" id="bookingTitle" name="title" value="${esc(booking.title)}" required></div>
      <div class="field"><label for="bookingStudent">學生</label><select class="input" id="bookingStudent" name="studentId"><option value="">未指定</option>${data.students.map(item => `<option value="${item.id}" ${item.id === booking.studentId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="bookingDate">日期</label><input type="date" class="input" id="bookingDate" name="date" value="${booking.date || todayISO()}" required></div>
      <div class="field"><label for="bookingStart">開始時間</label><input type="time" class="input" id="bookingStart" name="start" value="${booking.start || '14:00'}" required></div>
      <div class="field"><label for="bookingEnd">結束時間</label><input type="time" class="input" id="bookingEnd" name="end" value="${booking.end || '15:00'}" required></div>
      <div class="field"><label for="bookingStatus">狀態</label><select class="input" id="bookingStatus" name="status">${[['pending', '待確認'], ['confirmed', '已確認'], ['cancelled', '已取消']].map(([key, label]) => `<option value="${key}" ${key === booking.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="form-actions full">${booking.id ? '<button type="button" class="btn btn-danger" id="deletePrivateBooking">刪除</button>' : ''}<button type="submit" class="btn btn-primary">儲存</button></div>
    </form>`);
  $('#privateBookingForm').onsubmit = event => {
    event.preventDefault();
    if (session !== cloudSession) return;
    const fields = Object.fromEntries(new FormData(event.target));
    if (!fields.title.trim() || fields.end <= fields.start) { toast('請填寫名稱，並確認結束時間晚於開始時間。'); return; }
    const next = {...booking, ...fields, title: fields.title.trim(), id: booking.id || uid('booking')};
    data.bookings = [...data.bookings.filter(item => item.id !== next.id), next];
    save();
    closeModal();
    renderPrivateBookings();
  };
  if (booking.id) $('#deletePrivateBooking').onclick = () => {
    if (session !== cloudSession || !confirm('確定刪除這筆私人預約？')) return;
    data.bookings = data.bookings.filter(item => item.id !== booking.id);
    save();
    closeModal();
    renderPrivateBookings();
  };
}

function cloudErrorText(error) {
  if (['conflict', 'invalid-backup', 'invalid-workspace', 'workspace-too-large'].includes(error.code)) return error.message;
  if (error.code === 'permission-denied') return '目前沒有權限，請確認帳號核准狀態。';
  return '目前無法連線到雲端，請稍後重試。';
}

function draftPrefix(uidValue) {
  return `tutorflow-cloud-draft:${FIREBASE_CONFIG.projectId}:${uidValue}:`;
}

function cloudStatus(text, retry = false) {
  $('#cloudStatus').textContent = text;
  $('#retryCloudSave').hidden = !retry || !!cloudSession?.conflict;
  $('#reloadCloudData').hidden = !cloudSession?.conflict;
}

function showCloudGate(message, user, retry = false) {
  showAuthSetup(message);
  $('#cloudGateActions').hidden = !user && !retry;
  $('#cloudGateIdentity').textContent = user ? `帳號 UID：${user.uid}` : '';
  $('#verifyCloudEmail').hidden = !user?.email || user.emailVerified;
  $('#retryCloudAccount').hidden = !retry;
  $('#leaveCloudAccount').hidden = !user;
}

function lockCloudAccount() {
  accountGeneration++;
  membershipWatch?.();
  membershipWatch = null;
  cloudSession?.stopWatch?.();
  clearTimeout(cloudSession?.timer);
  cloudSession = null;
  cloudGateIdentity = null;
  data = null;
  document.body.classList.add('auth-locked');
  $('.app-shell').inert = true;
  $('.mobile-nav').inert = true;
  $('#modal').replaceChildren();
  $('#modalBackdrop').classList.remove('open');
  $('#toast').textContent = '';
}

function resetSignedInPage() {
  lockCloudAccount();
  // The reload starts a new UI session and removes any prior teacher details from the DOM immediately.
  $('.app-shell').replaceChildren();
  $('.mobile-nav').replaceChildren();
  location.reload();
}

function downloadWorkspace(workspace, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({...workspace, exportedAt: new Date().toISOString()}, null, 2)], {type: 'application/json'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function retainDraft(session) {
  try {
    localStorage.setItem(session.draftKey, JSON.stringify(session.pending));
    return true;
  } catch {
    return false;
  }
}

function removeDraft(session) {
  try { localStorage.removeItem(session.draftKey); } catch {}
}

function queueWorkspaceSave() {
  const session = cloudSession;
  if (!session || !data) return;
  const text = JSON.stringify(data);
  if (text === (session.pending?.text ?? session.base.text)) return;
  // Once submitted, keep the original mutation intact until we know its outcome.
  const queued = text;
  if (session.pending?.submitted) {
    session.pending.queued = queued;
  } else {
    session.pending = {text, mutationId: uid('mutation'), baseRevision: session.base.revision, when: Date.now()};
  }
  const kept = retainDraft(session);
  if (session.conflict) {
    cloudStatus(kept ? '其他裝置已有新資料。這台裝置的修改可在設定中匯出。' : '同步衝突，瀏覽器空間不足。請立即匯出修改。');
    return;
  }
  cloudStatus(kept ? '修改已暫存在此裝置，等待雲端確認。' : '此裝置無法暫存修改，請保留此頁直到同步完成。');
  clearTimeout(session.timer);
  session.timer = setTimeout(() => flushWorkspace(session), 500);
}

async function flushWorkspace(session = cloudSession) {
  if (!session || session !== cloudSession || session.conflict || session.busy) return false;
  if (!session.pending) return true;
  session.busy = true;
  const job = session.pending;
  job.submitted = true;
  retainDraft(session);
  cloudStatus('正在儲存到雲端…');
  try {
    const next = await session.store.write({text: job.text, base: session.base, mutationId: job.mutationId});
    if (session !== cloudSession) return false;
    session.base = next;
    session.pending = null;
    removeDraft(session);
    if (job.queued && job.queued !== next.text) {
      session.pending = {text: job.queued, mutationId: uid('mutation'), baseRevision: next.revision, when: Date.now()};
      retainDraft(session);
      session.timer = setTimeout(() => flushWorkspace(session), 0);
    }
    cloudStatus(session.pending ? '還有修改等待同步。' : '已儲存到雲端');
    return !session.pending;
  } catch (error) {
    if (session !== cloudSession) return false;
    if (error.code === 'conflict') session.conflict = true;
    cloudStatus(`${cloudErrorText(error)} 待同步的修改可在設定匯出。`, true);
    return false;
  } finally {
    session.busy = false;
    if (session === cloudSession && !session.pending && session.remoteRevision > session.base.revision) {
      refreshWorkspace(session, session.remoteRevision);
    }
  }
}

function replaceWorkspace(session, next) {
  const workspace = next.revision ? cloud.validateWorkspace(JSON.parse(next.text)).workspace : cloud.empty();
  session.base = next;
  data = workspace;
  if (next.revision) session.base.text = JSON.stringify(workspace);
  closeModal();
  renderView(state.view);
  cloudStatus(session.pending ? '有本機修改尚未同步。' : '已載入雲端資料', !!session.pending);
}

async function refreshWorkspace(session, revision) {
  session.remoteRevision = Math.max(session.remoteRevision, revision);
  if (session !== cloudSession || revision <= session.base.revision || session.busy || session.refreshing) return;
  if (session.pending || $('#modalBackdrop').classList.contains('open')) {
    session.conflict = true;
    cloudStatus('另一台裝置更新了資料。請先匯出本機待同步的修改，再重新載入雲端。');
    return;
  }
  session.refreshing = true;
  try {
    const next = await session.store.load();
    if (session !== cloudSession) return;
    if (session.pending || $('#modalBackdrop').classList.contains('open')) {
      session.conflict = true;
      cloudStatus('另一台裝置更新了資料。請先匯出本機修改，再重新載入雲端。');
      return;
    }
    replaceWorkspace(session, next);
  } catch (error) {
    if (session === cloudSession) cloudStatus(cloudErrorText(error), true);
  } finally {
    session.refreshing = false;
    if (session === cloudSession && !session.conflict && !session.pending && session.base.revision >= revision &&
        session.remoteRevision > session.base.revision) refreshWorkspace(session, session.remoteRevision);
  }
}

async function reloadCloudWorkspace() {
  const session = cloudSession;
  if (!session || session.busy || !confirm('重新載入雲端版本？待同步草稿會保留在此瀏覽器，可到設定匯出。')) return;
  try {
    const next = await session.store.load();
    if (session !== cloudSession || session.busy) return;
    if (session.pending && !retainDraft(session)) {
      downloadWorkspace(JSON.parse(session.pending.queued || session.pending.text), 'TutorFlow-待同步備份');
    }
    clearTimeout(session.timer);
    session.draftKey = draftPrefix(session.user.uid) + uid('draft');
    session.pending = null;
    session.conflict = false;
    replaceWorkspace(session, next);
  } catch (error) {
    if (session === cloudSession) cloudStatus(cloudErrorText(error), true);
  }
}

async function observeCloudAccount(user) {
  const previousUid = cloudGateIdentity?.uid;
  if (previousUid && previousUid !== user?.uid) {
    resetSignedInPage();
    return;
  }
  lockCloudAccount();
  const generation = accountGeneration;
  if (!user) {
    showAuthLogin();
    return;
  }
  cloudGateIdentity = user;
  showCloudGate('正在確認帳號資格…', user);
  try {
    const token = await user.getIdTokenResult();
    if (generation !== accountGeneration) return;
    if (!['phone', 'password'].includes(token.signInProvider)) {
      showCloudGate('請使用手機驗證碼或 Email＋密碼登入。', user);
      return;
    }
    const db = await firestoreDb();
    if (generation !== accountGeneration) return;
    const ref = db.collection('memberships').doc(user.uid);
    let requesting = false, opening = false, latestMembership = null;
    membershipWatch = ref.onSnapshot({includeMetadataChanges: true}, async snapshot => {
      if (generation !== accountGeneration || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      if (!snapshot.exists) {
        latestMembership = null;
        if (cloudSession) { resetSignedInPage(); return; }
        if (requesting) return;
        requesting = true;
        try {
          await db.runTransaction(async transaction => {
            if (!(await transaction.get(ref)).exists) transaction.set(ref, {role: 'teacher', status: 'pending'});
          });
        } catch (error) {
          if (generation === accountGeneration) showCloudGate(cloudErrorText(error), user, true);
        } finally {
          requesting = false;
        }
        return;
      }
      const membership = snapshot.data();
      latestMembership = membership;
      const active = membership.status === 'active' && ['admin', 'teacher'].includes(membership.role);
      if (cloudSession && (!active || membership.role !== cloudSession.membership.role || membership.legacyImport !== cloudSession.membership.legacyImport)) {
        resetSignedInPage();
        return;
      }
      if (token.signInProvider === 'password' && !token.claims.email_verified) {
        showCloudGate('請先驗證電子郵件，再重新檢查登入資格。', user, true);
        return;
      }
      if (!active) {
        showCloudGate(membership.status === 'disabled' ? '此老師帳號已停用。' : '帳號申請已送出，等待管理員核准。', user, true);
        return;
      }
      if (opening || cloudSession) return;
      opening = true;
      try {
        const store = cloud.workspaceStore(db, user.uid);
        const base = await store.load();
        if (generation !== accountGeneration || latestMembership?.status !== 'active') return;
        const workspace = base.revision ? cloud.validateWorkspace(JSON.parse(base.text)).workspace : cloud.empty();
        const session = {
          db, user, membership: latestMembership, store, base, remoteRevision: base.revision, pending: null, conflict: false,
          draftKey: draftPrefix(user.uid) + uid('draft')
        };
        cloudSession = session;
        data = workspace;
        startAuthenticatedApp(user);
        renderCloudAccount();
        session.stopWatch = store.watch(revision => refreshWorkspace(session, revision),
          error => { if (session === cloudSession) cloudStatus(cloudErrorText(error), true); });
        cloudStatus(base.revision ? '已載入雲端資料' : '這個帳號還沒有雲端資料');
      } catch (error) {
        if (generation === accountGeneration) showCloudGate(cloudErrorText(error), user, true);
      } finally {
        opening = false;
      }
    }, error => {
      if (generation !== accountGeneration) return;
      if (cloudSession) resetSignedInPage();
      else showCloudGate(cloudErrorText(error), user, true);
    });
  } catch (error) {
    if (generation === accountGeneration) showCloudGate(cloudErrorText(error), user, true);
  }
}

function renderCloudAccount() {
  const session = cloudSession;
  if (!session) return;
  $('#cloudAccount').textContent = `${session.user.email || session.user.phoneNumber || session.user.uid} · ${session.user.email ? 'Email＋密碼' : '手機'}${session.membership.role === 'admin' ? ' · 管理員' : ''}`;
  $('#legacyBackup').hidden = session.membership.legacyImport !== true;
  $('#teacherAdmin').hidden = session.membership.role !== 'admin';
  $('#availabilitySyncScope').textContent = '同步後，空堂會儲存到你帳號下的公開文件。';
}

async function showTeacherAdmin() {
  const session = cloudSession;
  if (!session || session.membership.role !== 'admin') return;
  const output = $('#teacherAdminRows');
  output.textContent = '正在讀取帳號…';
  try {
    const signupRef = session.db.collection('systemSettings').doc('main');
    const [snapshot, signup] = await Promise.all([
      session.db.collection('memberships').get({source: 'server'}), signupRef.get({source: 'server'})
    ]);
    if (session !== cloudSession) return;
    const toggle = $('#toggleSignup');
    const open = !signup.exists || signup.data().signupOpen === true;
    toggle.hidden = false;
    toggle.textContent = open ? '暫停新帳號申請' : '重新開放帳號申請';
    toggle.onclick = async () => {
      if (session !== cloudSession || !confirm(`確定要${toggle.textContent}？`)) return;
      toggle.disabled = true;
      try {
        await signupRef.set({signupOpen: !open});
        if (session === cloudSession) await showTeacherAdmin();
      } catch (error) {
        if (session === cloudSession) toast(cloudErrorText(error));
      } finally {
        toggle.disabled = false;
      }
    };
    output.replaceChildren();
    if (snapshot.empty) output.textContent = '目前沒有老師帳號。';
    for (const doc of snapshot.docs) {
      const membership = doc.data();
      const row = document.createElement('div');
      row.className = 'data-action';
      const label = document.createElement('span');
      label.textContent = `${doc.id} · ${{pending: '待核准', active: '使用中', disabled: '已停用'}[membership.status] || '未知狀態'}`;
      row.append(label);
      if (membership.role === 'teacher') {
        const button = document.createElement('button');
        const status = membership.status === 'active' ? 'disabled' : 'active';
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.textContent = status === 'active' ? '核准' : '停用';
        button.onclick = async () => {
          if (session !== cloudSession || !confirm(`確定要${button.textContent}帳號 ${doc.id}？`)) return;
          button.disabled = true;
          try {
            await doc.ref.update({status});
            if (session === cloudSession) await showTeacherAdmin();
          } catch (error) {
            if (session === cloudSession) { toast(cloudErrorText(error)); button.disabled = false; }
          }
        };
        row.append(button);
      }
      output.append(row);
    }
  } catch (error) {
    if (session === cloudSession) output.textContent = cloudErrorText(error);
  }
}

async function importCloudWorkspace(file) {
  const session = cloudSession;
  if (!session || !file) return;
  try {
    const preview = cloud.validateWorkspace(JSON.parse(await file.text()));
    const text = JSON.stringify(preview.workspace);
    cloud.encode(text);
    if (session !== cloudSession) return;
    if (session.pending || session.busy || session.refreshing || session.conflict) {
      throw cloud.failure('conflict', '請先處理目前待同步的資料，再匯入備份。');
    }
    if (text === session.base.text) { toast('這份備份已在雲端。'); return; }
    const initial = session.base.revision === 0;
    const countText = () => `學生 ${preview.counts.students} 位、課程 ${preview.counts.courses} 堂、教學紀錄 ${preview.counts.notes} 筆、預約 ${preview.counts.bookings} 筆、已收款課程 ${preview.paidLessons} 堂。無對應資料的關聯 ${preview.missingLinks} 筆。`;
    if (!confirm(`匯入到帳號 ${session.user.uid}\n${countText()}\n請確認這是你擁有的備份。${initial ? '' : '\n這會以備份取代目前工作區，並先下載現有雲端資料。'}`)) return;
    if (!initial) downloadWorkspace(data, 'TutorFlow-還原前備份');
    const mutationId = uid('import');
    session.busy = true;
    $('.app-shell').inert = true;
    $('.mobile-nav').inert = true;
    cloudStatus('正在原子匯入，請保持頁面開啟…');
    try {
      const next = await session.store.write({text, base: session.base, mutationId, migrate: initial});
      const verified = await session.store.load();
      if (verified.revision !== next.revision || verified.text !== text) throw cloud.failure('conflict', '雲端版本已變更。請先重新載入雲端資料再判斷是否需要重試。');
      if (session !== cloudSession) return;
      replaceWorkspace(session, verified);
      toast(`已核對雲端匯入。學生 ${preview.counts.students} 位、課程 ${preview.counts.courses} 堂`);
    } catch (error) {
      if (session !== cloudSession) return;
      // If the commit succeeded but the verification read failed, require a reload before another import.
      session.conflict = true;
      cloudStatus(`匯入未能完成確認。請重新載入雲端再核對；原始 JSON 仍可重試。${cloudErrorText(error)}`);
    } finally {
      session.busy = false;
      if (session === cloudSession) {
        $('.app-shell').inert = false;
        $('.mobile-nav').inert = false;
      }
    }
  } catch (error) {
    if (session === cloudSession) toast(error instanceof SyntaxError ? '備份不是有效的 JSON。' : cloudErrorText(error));
  }
}

function exportCloudDrafts() {
  const session = cloudSession;
  if (!session) return;
  const prefix = draftPrefix(session.user.uid);
  const saved = new Map();
  try {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(prefix))) {
      const draft = JSON.parse(localStorage.getItem(key));
      saved.set(key, draft);
    }
  } catch {}
  if (session.pending) saved.set(session.draftKey, session.pending);
  if (!saved.size) { toast('此帳號在這個瀏覽器沒有待同步草稿。'); return; }
  const rows = [...saved.values()].sort((a, b) => b.when - a.when);
  const choice = rows.length === 1 ? 1 : Number(prompt(rows.map((draft, index) =>
    `${index + 1}. ${new Date(draft.when).toLocaleString('zh-TW')}`).join('\n') + '\n請輸入要匯出的草稿編號。'));
  if (!rows[choice - 1]) return;
  const draft = rows[choice - 1];
  downloadWorkspace(JSON.parse(draft.queued || draft.text), 'TutorFlow-待同步備份');
}

function bindCloudWorkspace() {
  $('#addPrivateBooking').onclick = () => privateBookingForm();
  $('#retryCloudSave').onclick = () => {
    if (cloudSession?.pending) flushWorkspace();
    else if (cloudSession) reloadCloudWorkspace();
  };
  $('#reloadCloudData').onclick = reloadCloudWorkspace;
  $('#legacyBackup').onclick = () => {
    if (cloudSession?.membership.legacyImport !== true || !confirm('確認這台裝置的舊 TutorFlow 資料是你所有，並下載 JSON 備份？')) return;
    try {
      const original = localStorage.getItem(KEY);
      if (!original) { toast('這個網站來源沒有舊版資料。'); return; }
      downloadWorkspace(JSON.parse(original), 'TutorFlow-舊版備份');
    } catch { toast('無法讀取舊版備份。請從原本的 TutorFlow 匯出。'); }
  };
  $('#pendingDraft').onclick = exportCloudDrafts;
  $('#loadTeacherAdmin').onclick = showTeacherAdmin;
  $('#retryCloudAccount').onclick = async () => {
    try {
      const auth = await firebaseAuth();
      if (auth.currentUser) {
        await auth.currentUser.reload();
        await auth.currentUser.getIdToken(true);
      }
      await observeCloudAccount(auth.currentUser);
    } catch (error) { showCloudGate(cloudErrorText(error), cloudGateIdentity, true); }
  };
  $('#verifyCloudEmail').onclick = async () => {
    const user = cloudGateIdentity;
    try {
      await user.sendEmailVerification();
      if (user === cloudGateIdentity) showCloudGate('已寄出驗證信。驗證後請選「重新檢查」。', user, true);
    } catch (error) { if (user === cloudGateIdentity) showCloudGate(authErrorText(error), user, true); }
  };
}
