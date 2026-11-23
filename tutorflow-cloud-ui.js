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
      <button type="button" class="btn btn-secondary" id="sendAccountVerification" hidden>重寄驗證信</button>
      <button type="button" class="btn btn-secondary" id="retryCloudAccount">重新檢查</button>
      <button type="button" class="btn btn-ghost" id="leaveCloudAccount">返回登入</button>
      <p class="form-hint" id="verificationMessage" role="status" hidden></p>
    </div>`}));
  $('.topbar').insertAdjacentHTML('afterend', `
    <div class="cloud-sync-bar" aria-live="polite">
      <span id="cloudStatus"></span>
      <button type="button" class="btn btn-secondary btn-sm" id="retryCloudSave" hidden>重試同步</button>
      <button type="button" class="btn btn-secondary btn-sm" id="reloadCloudData" hidden>重新載入雲端</button>
    </div>`);
  $('#settings-account').insertAdjacentHTML('afterbegin', `
    <section class="card cloud-settings">
      <div class="section-head"><div><h2>雲端帳號</h2><p id="cloudAccount"></p></div>
        <button type="button" class="btn btn-ghost" id="logoutCloudSettings">登出</button>
      </div>
    </section>`);
  $('#settings-teachers').insertAdjacentHTML('afterbegin', `
    <section class="card cloud-settings" id="teacherAdmin">
      <div class="section-head"><h2>老師帳號管理</h2>
        <button type="button" class="btn btn-secondary" id="loadTeacherAdmin">載入帳號列表</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="toggleSignup" hidden></button>
      <p class="form-hint" id="teacherAdminSetup" hidden></p>
      <p class="form-hint" id="teacherAdminEmailStatus" role="status" hidden></p>
      <div id="teacherAdminRows"></div>
    </section>`);
  $('#availabilityPreview').insertAdjacentHTML('beforebegin', '<p class="form-hint" id="availabilitySyncScope"></p>');
  const availabilityCard = $('.availability-card');
  availabilityCard.querySelector('h2').textContent = '空堂管理';
  availabilityCard.querySelector('.section-head p').textContent = '設定每週可授課時間，自動扣除已安排的課程。';
  $('[data-availability-action="preview"]').remove();
  const backupCard = $('#exportData').closest('.card');
  backupCard.querySelector('.section-head p').textContent = '下載目前工作區，或預覽並匯入 TutorFlow JSON。';
  backupCard.insertAdjacentHTML('beforeend', `
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" id="pendingDraft">匯出待同步草稿</button>
      <button type="button" class="btn btn-secondary" id="legacyBackup" hidden>下載此瀏覽器的舊資料</button>
    </div>`);
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

function showCloudGate(message, user, retry = false, verifyEmail = false) {
  showAuthSetup(message);
  $('#cloudGateActions').hidden = !user && !retry;
  $('#cloudGateIdentity').textContent = user ? `帳號 UID：${user.uid}` : '';
  $('#retryCloudAccount').hidden = !retry;
  $('#leaveCloudAccount').hidden = !user;
  $('#sendAccountVerification').hidden = !verifyEmail;
  $('#verificationMessage').hidden = !verifyEmail;
}

async function sendAccountVerification(user) {
  const button = $('#sendAccountVerification'), message = $('#verificationMessage');
  if (!user?.email || user.emailVerified || button.disabled) return;
  const auth = await firebaseAuth();
  if (auth.currentUser?.uid !== user.uid || button.disabled) return;
  button.disabled = true;
  message.textContent = '正在寄送信箱驗證信…';
  try {
    await user.sendEmailVerification(authMailSettings());
    if (auth.currentUser?.uid === user.uid) {
      message.textContent = '驗證信已寄出。點開信中的連結後，回來按「重新檢查」。';
    }
  } catch (error) {
    if (auth.currentUser?.uid === user.uid) message.textContent = authErrorText(error);
  } finally {
    button.disabled = false;
  }
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
    if (token.signInProvider !== 'password') {
      showCloudGate('請返回登入，使用電子郵件和密碼。', user);
      return;
    }
    if (token.claims.email_verified !== true) {
      showCloudGate('請先驗證信箱，再按「重新檢查」。', user, true, true);
      return;
    }
    const db = await firestoreDb();
    if (generation !== accountGeneration) return;
    const ref = db.collection('memberships').doc(user.uid);
    const email = typeof token.claims.email === 'string' ? token.claims.email : '';
    let emailSync = null;
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
            if (!(await transaction.get(ref)).exists) {
              const application = {role: 'teacher', status: 'pending'};
              if (email) application.email = email;
              transaction.set(ref, application);
            }
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
      if (email && membership.email !== email && !emailSync &&
          ['pending', 'active', 'disabled'].includes(membership.status)) {
        emailSync = ref.update({email}).then(() => null, error => {
          console.warn('TutorFlow membership email sync failed', error.code);
          return error.code || 'unknown';
        });
      }
      const active = membership.status === 'active' && ['admin', 'teacher'].includes(membership.role);
      if (cloudSession && (!active || membership.role !== cloudSession.membership.role || membership.legacyImport !== cloudSession.membership.legacyImport)) {
        resetSignedInPage();
        return;
      }
      if (!active) {
        const messages = {disabled: '此老師帳號已停用。', deleting: '此帳號的雲端資料正在刪除。'};
        showCloudGate(messages[membership.status] || '帳號申請已送出，等待管理員核准。', user, true);
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
          db, user, membership: latestMembership, verifiedEmail: email || user.email, emailSync,
          store, base, remoteRevision: base.revision, pending: null, conflict: false,
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
  $('#cloudAccount').textContent = `${session.user.email || session.user.uid}${session.membership.role === 'admin' ? ' · 管理員' : ''}`;
  $('#legacyBackup').hidden = session.membership.legacyImport !== true;
  const teacherTab = $('#settings-tab-teachers');
  teacherTab.hidden = session.membership.role !== 'admin';
  if (teacherTab.hidden && teacherTab.getAttribute('aria-selected') === 'true') {
    selectSettingsTab($('#settings-tab-data'));
  }
  $('#availabilitySyncScope').textContent = '同步後，空堂會儲存到你帳號下的公開文件。';
}

function selectSettingsTab(selected) {
  for (const tab of $$('.settings-tab')) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
}

function bindSettingsTabs() {
  const tabs = $('.settings-tabs');
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('.settings-tab');
    if (tab && !tab.hidden) selectSettingsTab(tab);
  });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const visible = [...tabs.querySelectorAll('.settings-tab:not([hidden])')];
    const current = visible.indexOf(event.target);
    if (current < 0) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
    selectSettingsTab(visible[index]);
    visible[index].focus();
  });
}

async function showTeacherAdmin() {
  const session = cloudSession;
  if (!session || session.membership.role !== 'admin') return;
  const output = $('#teacherAdminRows');
  const adminOrigin = teacherAdminOrigin();
  const setup = $('#teacherAdminSetup');
  const emailStatus = $('#teacherAdminEmailStatus');
  setup.hidden = true;
  emailStatus.hidden = true;
  session.emailSync?.then(code => {
    if (!code || session !== cloudSession) return;
    emailStatus.textContent = code === 'permission-denied'
      ? '無法將你的信箱存入會員資料（permission-denied）。請確認 turtorflow 預設資料庫已發布新版 Firestore 規則。'
      : `無法將你的信箱存入會員資料（${code}）。請重新登入後再試。`;
    emailStatus.hidden = false;
  });
  output.textContent = '正在讀取帳號…';
  try {
    const signupRef = session.db.collection('systemSettings').doc('main');
    const [snapshot, signup, emails] = await Promise.all([
      session.db.collection('memberships').get({source: 'server'}), signupRef.get({source: 'server'}),
      adminOrigin ? loadTeacherEmails(session, adminOrigin).catch(() => null) : null
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
    let missingEmailCount = 0;
    for (const doc of snapshot.docs) {
      const membership = doc.data();
      const row = document.createElement('div');
      row.className = 'data-action';
      const label = document.createElement('span');
      const statuses = {pending: '待核准', active: '使用中', disabled: '已停用', deleting: '刪除處理中'};
      const email = doc.id === session.user.uid
        ? session.verifiedEmail || membership.email
        : emails ? emails.get(doc.id) : membership.email;
      if (!email) missingEmailCount++;
      const identity = email || `尚無已驗證信箱（${doc.id}）`;
      label.textContent = `${identity} · ${statuses[membership.status] || '未知狀態'}`;
      row.append(label);
      if (membership.role === 'teacher' && doc.id !== session.user.uid && membership.status !== 'deleting') {
        const button = document.createElement('button');
        const status = membership.status === 'active' ? 'disabled' : 'active';
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.textContent = status === 'active' ? '核准' : '停用';
        button.onclick = async () => {
          if (session !== cloudSession || !confirm(`確定要${button.textContent}帳號 ${identity}？`)) return;
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
      if (adminOrigin && membership.role === 'teacher' && doc.id !== session.user.uid) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-danger';
        button.textContent = membership.status === 'deleting' ? '繼續刪除' : '刪除帳號';
        button.onclick = () => confirmTeacherDeletion(session, doc.id, identity, adminOrigin, row);
        row.append(button);
      }
      output.append(row);
    }
    const notices = [];
    if (missingEmailCount) {
      notices.push(`還有 ${missingEmailCount} 筆會員沒有信箱。請該帳號完成信箱驗證並登入新版 TutorFlow，再重新載入老師名單。`);
    }
    if (!adminOrigin) notices.push('刪除會員紀錄請使用 Firebase Console。');
    setup.textContent = notices.join(' ');
    setup.hidden = !notices.length;
  } catch (error) {
    if (session === cloudSession) output.textContent = cloudErrorText(error);
  }
}

function teacherAdminOrigin() {
  try {
    const url = new URL(window.TUTORFLOW_ACCOUNT_ADMIN_URL);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      return url.origin;
    }
  } catch {}
  return '';
}

async function loadTeacherEmails(session, origin) {
  const token = await session.user.getIdToken();
  if (session !== cloudSession) return null;
  const response = await fetch(origin + '/admin/teacher-emails', {
    redirect: 'error', headers: {Authorization: `Bearer ${token}`}
  });
  const result = await response.json();
  if (!response.ok || !Array.isArray(result.teachers)) throw Error('無法取得帳號信箱');
  return new Map(result.teachers.map(({uid, email}) => [uid, email]));
}

async function confirmTeacherDeletion(session, uid, identity, origin, row) {
  if (session !== cloudSession) return;
  if (!confirm(`將永久刪除 ${identity} 的老師帳號及其學生、課程、教學紀錄、財務和公開空堂。確定刪除？`)) return;
  row.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const token = await session.user.getIdToken(true);
    if (session !== cloudSession) return;
    const response = await fetch(origin + '/admin/delete-teacher', {
      method: 'POST',
      redirect: 'error',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify({uid, confirmUid: uid})
    });
    const result = await response.json();
    if (session !== cloudSession) return;
    if (response.ok && result.deleted === true) {
      toast('老師帳號及雲端紀錄已刪除。');
    } else {
      const messages = {
        unauthenticated: '登入資格已失效，請重新登入。',
        forbidden: '目前帳號沒有刪除權限。',
        'protected-account': '這個帳號受到保護。',
        'teacher-not-found': '找不到這個老師帳號，請重新載入列表。',
        'concurrent-change': '帳號狀態已變更，請重新確認。',
        'not-configured': '帳號管理服務還沒完成設定。',
        'delete-incomplete': '帳號已鎖定。請按「繼續刪除」完成清理。'
      };
      toast(messages[result.code] || '暫時無法確認刪除結果，請重新載入列表。');
    }
  } catch {
    if (session === cloudSession) toast('暫時無法確認刪除結果，請重新載入列表。');
  } finally {
    if (session === cloudSession) await showTeacherAdmin();
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
  bindSettingsTabs();
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
  $('#sendAccountVerification').onclick = () => sendAccountVerification(cloudGateIdentity);
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
}
