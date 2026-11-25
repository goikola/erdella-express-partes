(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const KEYS = {
    access: "erdellaExpressAccessV1",
    records: "erdellaExpressRecordsV1",
    recordsBackup: "erdellaExpressRecordsBackupV1",
    draft: "erdellaExpressDraftV1",
    lists: "erdellaExpressListsV1",
    lastWorker: "erdellaExpressLastWorkerV1",
    lastVehicle: "erdellaExpressLastVehicleV1",
    monthlySent: "erdellaExpressMonthlySentV1",
    reminderShown: "erdellaExpressReminderShownV1",
    cloudDeletions: "erdellaExpressCloudDeletionsV1",
    cloudDevice: "erdellaExpressCloudDeviceV1"
  };
  const LOGIN = { user: "express", password: "3000" };
  const ADMIN = { user: "etor", password: "1974" };
  const MONTHLY_RECIPIENT = "distribucion@erdellaexpres.com";
  const MULTI_CENTER = "Varios centros";
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBjT_49FR1Fxq6kuph4n8L2SGje1WxYxJs",
    authDomain: "partes-trabajo-erdella.firebaseapp.com",
    databaseURL: "https://partes-trabajo-erdella-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "partes-trabajo-erdella",
    storageBucket: "partes-trabajo-erdella.firebasestorage.app",
    messagingSenderId: "466779972722",
    appId: "1:466779972722:web:14db41bbe079d869408eeb"
  };
  const defaults = {
    workers: [...window.EXPRESS_DATA.workers],
    vehicles: [...window.EXPRESS_DATA.vehicles],
    centers: [...window.EXPRESS_DATA.centers]
  };
  let records = readProtectedRecords();
  let lists = normalizeLists(readJson(KEYS.lists, defaults));
  let adminUnlocked = false;
  let deferredInstall = null;
  const pendingNotifications = new Set();
  let cloudUser = null;
  let cloudReadyPromise = null;
  let cloudSyncPromise = null;
  let draftSyncTimer = null;

  const fields = {
    id: $("recordId"), date: $("date"), worker: $("worker"), vehicle: $("vehicle"),
    center: $("center"), centerOther: $("centerOther"), startKm: $("startKm"), endKm: $("endKm"),
    morningStart: $("morningStart"), morningEnd: $("morningEnd"),
    afternoonStart: $("afternoonStart"), afternoonEnd: $("afternoonEnd"),
    onlineOrders: $("onlineOrders"), boxOrders: $("boxOrders"), specialOrders: $("specialOrders"),
    refuelKm: $("refuelKm"), refuelLiters: $("refuelLiters"), notes: $("notes")
  };

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function readProtectedRecords() {
    for (const key of [KEYS.records, KEYS.recordsBackup]) {
      const value = readJson(key, null);
      if (Array.isArray(value)) return value;
    }
    return [];
  }
  function saveProtectedRecords(value = records) {
    const serialized = JSON.stringify(value);
    const previous = localStorage.getItem(KEYS.records);
    if (previous) localStorage.setItem(KEYS.recordsBackup, previous);
    localStorage.setItem(KEYS.records, serialized);
    localStorage.setItem(KEYS.recordsBackup, serialized);
  }
  function setCloudStatus(text, error = false) {
    const box = $("cloudStatus");
    if (!box) return;
    box.textContent = text;
    box.classList.toggle("error", error);
    box.style.background = error ? "#fff1cf" : "#dff3e4";
    box.style.color = error ? "#704b00" : "#155d2c";
  }
  const cloudRecordKey = id => String(id).replace(/[.#$\[\]/]/g, "_");
  function pendingCloudDeletions() {
    const value = readJson(KEYS.cloudDeletions, []);
    return Array.isArray(value) ? value : [];
  }
  function rememberCloudDeletion(id) {
    saveJson(KEYS.cloudDeletions, [...new Set([...pendingCloudDeletions(), id])]);
  }
  function cloudDeviceName() {
    return localStorage.getItem(KEYS.lastWorker) || fields.worker.value || "Dispositivo sin identificar";
  }
  function initializeCloudSync() {
    if (cloudReadyPromise) return cloudReadyPromise;
    cloudReadyPromise = new Promise(resolve => {
      if (!window.firebase?.auth || !window.firebase?.database) { resolve(null); return; }
      try {
        const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
        const auth = app.auth();
        auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
        const stop = auth.onAuthStateChanged(async user => {
          if (!user) {
            try { await auth.signInAnonymously(); }
            catch (error) { console.warn("No se pudo iniciar la sincronización.", error); resolve(null); }
            return;
          }
          stop(); cloudUser = user; localStorage.setItem(KEYS.cloudDevice, user.uid); resolve(user);
          syncExistingRecords().catch(error => {
            setCloudStatus("Guardado en el móvil. La copia en la nube está pendiente.", true);
            console.warn("La copia en la nube está pendiente.", error);
          });
        }, error => { console.warn("No se pudo iniciar la sincronización.", error); resolve(null); });
      } catch (error) { console.warn("La sincronización no está disponible.", error); resolve(null); }
    });
    return cloudReadyPromise;
  }
  async function syncRecord(record) {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`expressDevices/${user.uid}`).update({
      [`records/${cloudRecordKey(record.id)}`]: record,
      draft: null,
      "metadata/name": record.worker || cloudDeviceName(),
      "metadata/lastSeen": firebase.database.ServerValue.TIMESTAMP
    });
    return true;
  }
  async function syncDraft(draft) {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`expressDevices/${user.uid}`).update({
      draft: { ...draft, savedAt: firebase.database.ServerValue.TIMESTAMP },
      "metadata/name": draft.worker || cloudDeviceName(),
      "metadata/lastSeen": firebase.database.ServerValue.TIMESTAMP
    });
    return true;
  }
  function scheduleDraftSync(draft) {
    clearTimeout(draftSyncTimer);
    draftSyncTimer = setTimeout(() => syncDraft(draft).catch(error => {
      setCloudStatus("Borrador guardado en el móvil; copia en nube pendiente.", true);
      console.warn("El borrador queda pendiente de sincronizar.", error);
    }), 700);
  }
  async function removeCloudRecord(id) {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`expressDevices/${user.uid}/records/${cloudRecordKey(id)}`).remove();
    saveJson(KEYS.cloudDeletions, pendingCloudDeletions().filter(item => item !== id));
    return true;
  }
  async function syncExistingRecords() {
    if (cloudSyncPromise) return cloudSyncPromise;
    cloudSyncPromise = (async () => {
      const user = cloudUser || await initializeCloudSync();
      if (!user) { setCloudStatus("Guardado local activo. No se pudo conectar con la copia en la nube.", true); return false; }
      setCloudStatus("Comprobando la copia de seguridad…");
      const deviceRef = firebase.database().ref(`expressDevices/${user.uid}`);
      const snapshot = await deviceRef.once("value");
      const remote = snapshot.val() || {};
      const deleted = new Set(pendingCloudDeletions());
      const merged = new Map();
      const keepNewest = record => {
        if (!record?.id || deleted.has(record.id)) return;
        const previous = merged.get(record.id);
        if (!previous || String(record.updatedAt || "") >= String(previous.updatedAt || "")) merged.set(record.id, record);
      };
      records.forEach(keepNewest);
      Object.values(remote.records || {}).forEach(keepNewest);
      records = [...merged.values()];
      saveProtectedRecords();
      if (!localStorage.getItem(KEYS.draft) && remote.draft && typeof remote.draft === "object") {
        const { savedAt, ...remoteDraft } = remote.draft;
        saveJson(KEYS.draft, remoteDraft);
        const formIsEmpty = !fields.center.value && !fields.morningStart.value && !fields.afternoonStart.value && !fields.startKm.value && !fields.endKm.value;
        if (formIsEmpty) restoreDraft();
      }
      const updates = {};
      records.forEach(record => { updates[`records/${cloudRecordKey(record.id)}`] = record; });
      pendingCloudDeletions().forEach(id => { updates[`records/${cloudRecordKey(id)}`] = null; });
      const localDraft = readJson(KEYS.draft, null);
      if (localDraft) updates.draft = { ...localDraft, savedAt: firebase.database.ServerValue.TIMESTAMP };
      updates["metadata/name"] = cloudDeviceName();
      updates["metadata/lastSeen"] = firebase.database.ServerValue.TIMESTAMP;
      await deviceRef.update(updates);
      localStorage.removeItem(KEYS.cloudDeletions);
      renderRecords(); setCloudStatus("Copia de seguridad en la nube al día.");
      return true;
    })();
    try { return await cloudSyncPromise; }
    finally { cloudSyncPromise = null; }
  }
  function unique(values) {
    return [...new Set((values || []).map(value => String(value || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
  }
  function normalizeLists(value) {
    const sourceCenters = value?.centers?.length ? value.centers : defaults.centers;
    const legacyCenters = sourceCenters.map(item => String(item || "").trim()).filter(Boolean);
    const centers = legacyCenters.filter(item => !["Varios centros", "Arenas", "Getxo", "Zalla", "Balmaseda"].includes(item));
    if (legacyCenters.some(item => ["Arenas", "Getxo", "Arenas-Getxo"].includes(item))) centers.push("Arenas-Getxo");
    if (legacyCenters.some(item => ["Zalla", "Balmaseda", "Zalla-Balmaseda"].includes(item))) centers.push("Zalla-Balmaseda");
    if (!centers.includes("Trobika (Mungia)")) centers.push("Trobika (Mungia)");
    return {
      workers: unique(value?.workers?.length ? value.workers : defaults.workers),
      vehicles: unique(value?.vehicles?.length ? value.vehicles : defaults.vehicles).map(value => value.toUpperCase()),
      centers: unique(centers)
    };
  }
  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function daysAgo(amount, from = new Date()) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    date.setDate(date.getDate() - amount);
    return date;
  }
  function reminderDates(now = new Date()) {
    const dates = [];
    const yesterday = daysAgo(1, now);
    if (yesterday.getDay() !== 6) dates.push(localDateKey(yesterday));

    // El parte del sábado no vence hasta el martes y sigue pendiente hasta que se guarde.
    const daysSinceSaturday = (now.getDay() + 1) % 7;
    if (daysSinceSaturday >= 3) dates.push(localDateKey(daysAgo(daysSinceSaturday, now)));
    return [...new Set(dates)].sort();
  }
  function pendingReminderDates(now = new Date()) {
    const worker = (localStorage.getItem(KEYS.lastWorker) || "").trim();
    if (!worker) return [];
    return reminderDates(now).filter(date => !records.some(record =>
      record.date === date && String(record.worker || "").localeCompare(worker, "es", { sensitivity: "base" }) === 0
    ));
  }
  function reminderText(dates) {
    const labels = dates.map(displayDate);
    if (labels.length === 1) return `Falta guardar la jornada del ${labels[0]}.`;
    return `Faltan guardar las jornadas del ${labels.slice(0, -1).join(", ")} y ${labels.at(-1)}.`;
  }
  async function showSystemReminder(dates) {
    if (!("Notification" in window) || Notification.permission !== "granted" || !dates.length) return;
    const shown = readJson(KEYS.reminderShown, {});
    const key = `${today()}:${dates.join(",")}`;
    if (shown[key] || pendingNotifications.has(key)) return;
    pendingNotifications.add(key);
    try {
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
      const options = { body: reminderText(dates), icon: "icon.svg", badge: "icon.svg", tag: `parte-pendiente-${dates.join("-")}` };
      if (registration) await registration.showNotification("Erdella Express · Parte pendiente", options);
      else new Notification("Erdella Express · Parte pendiente", options);
      saveJson(KEYS.reminderShown, { [key]: new Date().toISOString() });
    } catch { /* El aviso visible dentro de la aplicación permanece disponible. */ }
    finally { pendingNotifications.delete(key); }
  }
  function renderMissingDayReminder() {
    const reminder = $("missingDayReminder");
    const dates = pendingReminderDates();
    reminder.hidden = !dates.length;
    if (!dates.length) return;
    $("missingDayReminderText").textContent = reminderText(dates) + " Los sábados se pueden completar hasta el martes.";
    const button = $("enableNotificationsButton");
    button.hidden = !("Notification" in window) || Notification.permission === "granted";
    showSystemReminder(dates);
  }
  function uid() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function asNumber(value) { return value === "" || value == null ? null : Number(value); }
  function orderNumber(value) { return Math.max(0, Number(value || 0)); }
  function selectedRefuel() { return document.querySelector('input[name="refueled"]:checked')?.value || ""; }
  function setRefuel(value) {
    document.querySelectorAll('input[name="refueled"]').forEach(input => { input.checked = input.value === value; });
    toggleRefuel();
  }
  function minutesBetween(start, end) {
    if (!start || !end) return 0;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    let minutes = (eh * 60 + em) - (sh * 60 + sm);
    if (minutes < 0) minutes += 24 * 60;
    return minutes;
  }
  function totalMinutes(record) {
    if (record.center === MULTI_CENTER) return (record.centerLines || []).reduce((total, line) => total + minutesBetween(line.startTime, line.endTime), 0);
    return minutesBetween(record.morningStart, record.morningEnd) + minutesBetween(record.afternoonStart, record.afternoonEnd);
  }
  function totalDistance(record) {
    if (record.center === MULTI_CENTER) return (record.centerLines || []).reduce((total, line) => total + Math.max(0, Number(line.endKm) - Number(line.startKm)), 0);
    return record.startKm != null && record.endKm != null ? Math.max(0, Number(record.endKm) - Number(record.startKm)) : null;
  }
  function durationLabel(minutes) {
    if (!minutes) return "—";
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  }
  function displayDate(value) {
    if (!value) return "";
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  function centerLabel(record) {
    if (record.center === MULTI_CENTER) return `${MULTI_CENTER} (${(record.centerLines || []).length})`;
    return record.center === "Otras" ? (record.centerOther || "Otras") : record.center;
  }
  function totalOrders(record) {
    if (record.center === MULTI_CENTER && Array.isArray(record.centerLines)) {
      const lineTotal = record.centerLines.reduce((total, line) => total + orderNumber(line.onlineOrders) + orderNumber(line.boxOrders) + orderNumber(line.specialOrders), 0);
      const hasLineOrders = record.centerLines.some(line => line.onlineOrders != null || line.boxOrders != null || line.specialOrders != null);
      if (hasLineOrders) return lineTotal;
    }
    return orderNumber(record.onlineOrders) + orderNumber(record.boxOrders) + orderNumber(record.specialOrders);
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  function previousMonthKey(date = new Date()) {
    return monthKey(new Date(date.getFullYear(), date.getMonth() - 1, 1));
  }
  function secondBusinessDay(year, monthIndex) {
    let count = 0;
    for (let day = 1; day <= 10; day++) {
      const date = new Date(year, monthIndex, day);
      if (date.getDay() !== 0 && date.getDay() !== 6 && ++count === 2) return date;
    }
    return new Date(year, monthIndex, 2);
  }
  function monthlyRecords() {
    const key = previousMonthKey();
    return records.filter(record => String(record.date || "").startsWith(key));
  }
  function monthlyDeliveryIsDue() {
    const now = new Date();
    const due = secondBusinessDay(now.getFullYear(), now.getMonth());
    due.setHours(0, 0, 0, 0);
    const sent = readJson(KEYS.monthlySent, {});
    return now >= due && !sent[previousMonthKey()] && monthlyRecords().length > 0;
  }
  function renderMonthlyDelivery() {
    const banner = $("monthlyDelivery");
    if (!monthlyDeliveryIsDue()) { banner.hidden = true; return; }
    const month = previousMonthKey();
    const count = monthlyRecords().length;
    banner.hidden = false;
    $("monthlyDeliveryText").textContent = `Hay ${count} ${count === 1 ? "jornada" : "jornadas"} de ${month}. Se crearán los Excel por trabajador para ${MONTHLY_RECIPIENT}.`;
  }
  function safeFilePart(value) {
    return String(value || "usuario").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  }
  async function prepareMonthlyDelivery() {
    const month = previousMonthKey();
    const monthly = monthlyRecords();
    const workers = unique(monthly.map(record => record.worker));
    const files = workers.map(worker => {
      const blob = window.ExpressXlsx.build(monthly.filter(record => record.worker === worker), minutesBetween);
      return new File([blob], `Erdella-Express-${month}-${safeFilePart(worker)}.xlsx`, { type: blob.type });
    });
    if (!files.length) return;
    try { await navigator.clipboard?.writeText(MONTHLY_RECIPIENT); } catch { /* El portapapeles puede estar bloqueado. */ }
    const shareData = {
      title: `Partes Erdella Express ${month}`,
      text: `Destinatario: ${MONTHLY_RECIPIENT}\nPartes de trabajo de Erdella Express correspondientes a ${month}.`,
      files
    };
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
      try {
        await navigator.share(shareData);
        const sent = readJson(KEYS.monthlySent, {});
        sent[month] = new Date().toISOString();
        saveJson(KEYS.monthlySent, sent);
        showMessage($("monthlyDeliveryMessage"), `Archivos compartidos. El destinatario ${MONTHLY_RECIPIENT} se ha copiado para pegarlo en el correo.`);
        setTimeout(renderMonthlyDelivery, 2500);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    files.forEach(file => {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url; link.download = file.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    showMessage($("monthlyDeliveryMessage"), `Los Excel se han descargado. Envíalos a ${MONTHLY_RECIPIENT}.`, false);
    location.href = `mailto:${MONTHLY_RECIPIENT}?subject=${encodeURIComponent(`Partes Erdella Express ${month}`)}&body=${encodeURIComponent("Adjunto los partes mensuales generados por la aplicación.")}`;
  }

  function showMessage(element, text, error = false) {
    element.textContent = text;
    element.classList.toggle("error", error);
    element.hidden = false;
  }
  function hideMessage(element) { element.hidden = true; element.textContent = ""; }

  function showApp() {
    document.body.classList.remove("auth-locked");
    $("loginScreen").hidden = true;
    renderMonthlyDelivery();
    renderMissingDayReminder();
  }
  function initAccess() {
    if (localStorage.getItem(KEYS.access) === "ok") showApp();
    $("loginForm").addEventListener("submit", event => {
      event.preventDefault();
      const user = $("loginUser").value.trim().toLowerCase();
      const password = $("loginPassword").value;
      if (user !== LOGIN.user || password !== LOGIN.password) {
        showMessage($("loginError"), "Usuario o contraseña incorrectos.", true); return;
      }
      localStorage.setItem(KEYS.access, "ok");
      hideMessage($("loginError"));
      showApp();
    });
  }

  function fillLists() {
    $("workerList").replaceChildren(...lists.workers.map(value => new Option(value, value)));
    $("vehicleList").replaceChildren(...lists.vehicles.map(value => new Option(value, value)));
    const selected = fields.center.value;
    fields.center.replaceChildren(new Option("Seleccionar centro…", ""), new Option(MULTI_CENTER, MULTI_CENTER), ...lists.centers.map(value => new Option(value, value)));
    if (selected === MULTI_CENTER || lists.centers.includes(selected)) fields.center.value = selected;
    centerLines().forEach(line => fillLineCenterSelect(line.querySelector(".line-center"), line.querySelector(".line-center").value));
  }
  function saveLists() {
    lists = normalizeLists(lists);
    saveJson(KEYS.lists, lists);
    fillLists(); renderAdmin();
  }

  const centerLines = () => [...$("centerLines").querySelectorAll(".center-line")];
  function fillLineCenterSelect(select, selected = "") {
    select.replaceChildren(new Option("Seleccionar centro…", ""), ...lists.centers.map(value => new Option(value, value)));
    if (lists.centers.includes(selected)) select.value = selected;
  }
  function renumberCenterLines() {
    centerLines().forEach((line, index) => { line.querySelector(".center-line-title").textContent = `Centro ${index + 1}`; });
  }
  function toggleLineOther(line) {
    const other = line.querySelector(".line-center").value === "Otras";
    const label = line.querySelector(".line-center-other-label");
    const input = line.querySelector(".line-center-other");
    label.hidden = !other; input.required = other;
    if (!other) input.value = "";
  }
  function readCenterLine(line) {
    return {
      center: line.querySelector(".line-center").value,
      centerOther: line.querySelector(".line-center-other").value.trim(),
      startTime: line.querySelector(".line-start-time").value,
      endTime: line.querySelector(".line-end-time").value,
      startKm: asNumber(line.querySelector(".line-start-km").value),
      endKm: asNumber(line.querySelector(".line-end-km").value),
      onlineOrders: orderNumber(line.querySelector(".line-online-orders").value),
      boxOrders: orderNumber(line.querySelector(".line-box-orders").value),
      specialOrders: orderNumber(line.querySelector(".line-special-orders").value)
    };
  }
  function refreshCenterLine(line) {
    const data = readCenterLine(line);
    line.querySelector(".line-duration").textContent = durationLabel(minutesBetween(data.startTime, data.endTime));
    line.querySelector(".line-distance").textContent = data.startKm != null && data.endKm != null && data.endKm >= data.startKm ? `${(data.endKm - data.startKm).toLocaleString("es-ES")} km` : "—";
    line.querySelector(".line-orders-total").textContent = (data.onlineOrders + data.boxOrders + data.specialOrders).toLocaleString("es-ES");
  }
  function createCenterLine(data = {}) {
    const line = $("centerLineTemplate").content.firstElementChild.cloneNode(true);
    const select = line.querySelector(".line-center");
    fillLineCenterSelect(select, data.center || "");
    line.querySelector(".line-center-other").value = data.centerOther || "";
    line.querySelector(".line-start-time").value = data.startTime || "";
    line.querySelector(".line-end-time").value = data.endTime || "";
    line.querySelector(".line-start-km").value = data.startKm ?? "";
    line.querySelector(".line-end-km").value = data.endKm ?? "";
    line.querySelector(".line-online-orders").value = data.onlineOrders || "";
    line.querySelector(".line-box-orders").value = data.boxOrders || "";
    line.querySelector(".line-special-orders").value = data.specialOrders || "";
    select.addEventListener("change", () => { toggleLineOther(line); refreshCenterLine(line); refreshCalculations(); saveDraft(); });
    line.querySelectorAll("input").forEach(input => input.addEventListener("input", () => { refreshCenterLine(line); refreshCalculations(); saveDraft(); }));
    line.querySelector(".remove-center-line").addEventListener("click", () => {
      line.remove();
      if (!centerLines().length && fields.center.value === MULTI_CENTER) createCenterLine();
      renumberCenterLines(); refreshCalculations(); saveDraft();
    });
    $("centerLines").append(line);
    toggleLineOther(line); refreshCenterLine(line); renumberCenterLines();
    return line;
  }
  function toggleMultipleCenters() {
    const multiple = fields.center.value === MULTI_CENTER;
    $("mainStartKmField").hidden = multiple;
    $("mainEndKmField").hidden = multiple;
    $("mainShifts").hidden = multiple;
    $("mainOrders").hidden = multiple;
    $("multipleCenters").hidden = !multiple;
    fields.startKm.required = !multiple; fields.endKm.required = !multiple;
    if (multiple) {
      fields.startKm.value = ""; fields.endKm.value = "";
      fields.morningStart.value = ""; fields.morningEnd.value = "";
      fields.afternoonStart.value = ""; fields.afternoonEnd.value = "";
      if (!centerLines().length) createCenterLine();
    } else {
      $("centerLines").replaceChildren();
    }
  }
  function toggleOtherCenter() {
    const isOther = fields.center.value === "Otras";
    $("otherCenterField").hidden = !isOther;
    fields.centerOther.required = isOther;
    if (!isOther) fields.centerOther.value = "";
    toggleMultipleCenters();
  }
  function toggleRefuel() {
    const yes = selectedRefuel() === "Sí";
    $("refuelDetails").hidden = !yes;
    fields.refuelKm.required = yes;
    fields.refuelLiters.required = yes;
    if (!yes) { fields.refuelKm.value = ""; fields.refuelLiters.value = ""; }
  }
  function currentRecord() {
    const lines = fields.center.value === MULTI_CENTER ? centerLines().map(readCenterLine) : [];
    const onlineOrders = fields.center.value === MULTI_CENTER ? lines.reduce((total, line) => total + line.onlineOrders, 0) : orderNumber(fields.onlineOrders.value);
    const boxOrders = fields.center.value === MULTI_CENTER ? lines.reduce((total, line) => total + line.boxOrders, 0) : orderNumber(fields.boxOrders.value);
    const specialOrders = fields.center.value === MULTI_CENTER ? lines.reduce((total, line) => total + line.specialOrders, 0) : orderNumber(fields.specialOrders.value);
    return {
      id: fields.id.value || uid(),
      date: fields.date.value,
      worker: fields.worker.value.trim(),
      vehicle: fields.vehicle.value.trim().toUpperCase(),
      center: fields.center.value,
      centerOther: fields.centerOther.value.trim(),
      startKm: asNumber(fields.startKm.value),
      endKm: asNumber(fields.endKm.value),
      morningStart: fields.morningStart.value,
      morningEnd: fields.morningEnd.value,
      afternoonStart: fields.afternoonStart.value,
      afternoonEnd: fields.afternoonEnd.value,
      centerLines: lines,
      onlineOrders,
      boxOrders,
      specialOrders,
      refueled: selectedRefuel(),
      refuelKm: asNumber(fields.refuelKm.value),
      refuelLiters: asNumber(fields.refuelLiters.value),
      notes: fields.notes.value.trim(),
      updatedAt: new Date().toISOString()
    };
  }
  function saveDraft() {
    const draft = currentRecord();
    saveJson(KEYS.draft, draft);
    scheduleDraftSync(draft);
  }
  function clearDraft() { localStorage.removeItem(KEYS.draft); }
  function restoreDraft() {
    const draft = readJson(KEYS.draft, null);
    if (!draft) return false;
    loadRecord(draft, false);
    return true;
  }
  function loadRecord(record, scroll = true) {
    fields.id.value = record.id || "";
    fields.date.value = record.date || today();
    fields.worker.value = record.worker || "";
    fields.vehicle.value = record.vehicle || "";
    fields.center.value = record.center || "";
    toggleOtherCenter(); fields.centerOther.value = record.centerOther || "";
    if (fields.center.value === MULTI_CENTER) {
      $("centerLines").replaceChildren();
      const savedLines = Array.isArray(record.centerLines) ? record.centerLines.map(line => ({ ...line })) : [];
      const hasSavedLineOrders = savedLines.some(line => line.onlineOrders != null || line.boxOrders != null || line.specialOrders != null);
      if (savedLines.length && !hasSavedLineOrders) {
        savedLines[0].onlineOrders = orderNumber(record.onlineOrders);
        savedLines[0].boxOrders = orderNumber(record.boxOrders);
        savedLines[0].specialOrders = orderNumber(record.specialOrders);
      }
      if (savedLines.length) savedLines.forEach(createCenterLine); else createCenterLine();
    }
    fields.startKm.value = record.startKm ?? ""; fields.endKm.value = record.endKm ?? "";
    fields.morningStart.value = record.morningStart || ""; fields.morningEnd.value = record.morningEnd || "";
    fields.afternoonStart.value = record.afternoonStart || ""; fields.afternoonEnd.value = record.afternoonEnd || "";
    fields.onlineOrders.value = record.onlineOrders || ""; fields.boxOrders.value = record.boxOrders || ""; fields.specialOrders.value = record.specialOrders || "";
    setRefuel(record.refueled || "");
    fields.refuelKm.value = record.refuelKm ?? ""; fields.refuelLiters.value = record.refuelLiters ?? "";
    fields.notes.value = record.notes || "";
    $("formTitle").textContent = record.id && records.some(item => item.id === record.id) ? "Editar jornada" : "Nueva jornada";
    refreshCalculations();
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function resetForm(preservePrevious = true) {
    const worker = preservePrevious ? (localStorage.getItem(KEYS.lastWorker) || "") : "";
    const vehicle = preservePrevious ? (localStorage.getItem(KEYS.lastVehicle) || "") : "";
    $("workForm").reset();
    fields.id.value = ""; fields.date.value = today(); fields.worker.value = worker; fields.vehicle.value = vehicle;
    toggleOtherCenter(); toggleRefuel();
    $("formTitle").textContent = "Nueva jornada";
    hideMessage($("formMessage")); clearDraft(); refreshCalculations();
  }
  function validate(record) {
    if (!record.date || !record.worker || !record.vehicle || !record.center) return "Completa día, nombre, matrícula y centro.";
    if (record.center === "Otras" && !record.centerOther) return "Indica el nombre del otro centro.";
    if (record.center === MULTI_CENTER) {
      if (!record.centerLines.length) return "Añade al menos una línea de centro.";
      for (let index = 0; index < record.centerLines.length; index++) {
        const line = record.centerLines[index];
        const label = `centro ${index + 1}`;
        if (!line.center || !line.startTime || !line.endTime || line.startKm == null || line.endKm == null) return `Completa todos los datos del ${label}.`;
        if (line.center === "Otras" && !line.centerOther) return `Indica el nombre del ${label}.`;
        if (line.endKm < line.startKm) return `Los kilómetros finales del ${label} no pueden ser menores que los iniciales.`;
        if (minutesBetween(line.startTime, line.endTime) === 0) return `La hora inicial y final del ${label} no pueden ser iguales.`;
      }
    } else {
      if (record.startKm == null || record.endKm == null) return "Completa los kilómetros iniciales y finales.";
      if (record.endKm < record.startKm) return "Los kilómetros finales no pueden ser menores que los iniciales.";
      const morningPartial = Boolean(record.morningStart) !== Boolean(record.morningEnd);
      const afternoonPartial = Boolean(record.afternoonStart) !== Boolean(record.afternoonEnd);
      if (morningPartial) return "Completa las dos horas del turno de mañana o deja ambas vacías.";
      if (afternoonPartial) return "Completa las dos horas del turno de tarde o deja ambas vacías.";
      if (!record.morningStart && !record.afternoonStart) return "Completa al menos un turno: mañana o tarde.";
      if (record.morningStart && minutesBetween(record.morningStart, record.morningEnd) === 0) return "Las horas de mañana no pueden ser iguales.";
      if (record.afternoonStart && minutesBetween(record.afternoonStart, record.afternoonEnd) === 0) return "Las horas de tarde no pueden ser iguales.";
    }
    if (!record.refueled) return "Indica si has repostado la furgoneta.";
    if (record.refueled === "Sí" && (record.refuelKm == null || record.refuelLiters == null || record.refuelLiters <= 0)) return "Completa los kilómetros y litros del repostaje.";
    return "";
  }
  function refreshCalculations() {
    const record = currentRecord();
    $("duration").textContent = durationLabel(totalMinutes(record));
    const distance = totalDistance(record);
    $("distance").textContent = distance == null ? "—" : `${distance.toLocaleString("es-ES")} km`;
    $("totalOrders").textContent = totalOrders(record).toLocaleString("es-ES");
  }

  function renderRecords() {
    const month = $("monthFilter").value;
    const filtered = records.filter(record => !month || record.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const list = $("recordsList"); list.replaceChildren();
    $("recordCount").textContent = `${filtered.length} ${filtered.length === 1 ? "registro" : "registros"}`;
    $("emptyState").hidden = filtered.length > 0;
    for (const record of filtered) {
      const card = $("recordTemplate").content.firstElementChild.cloneNode(true);
      card.querySelector(".record-date").textContent = displayDate(record.date);
      card.querySelector(".record-worker").textContent = record.worker;
      card.querySelector(".record-center").textContent = centerLabel(record);
      card.querySelector(".record-vehicle").textContent = record.vehicle;
      const shifts = [];
      if (record.center === MULTI_CENTER) {
        const lines = record.centerLines || [];
        if (lines.length) shifts.push(`${lines[0].startTime}–${lines.at(-1).endTime}`);
      } else {
        if (record.morningStart) shifts.push(`Mañana ${record.morningStart}–${record.morningEnd}`);
        if (record.afternoonStart) shifts.push(`Tarde ${record.afternoonStart}–${record.afternoonEnd}`);
      }
      card.querySelector(".record-shifts").textContent = shifts.join(" · ");
      card.querySelector(".record-hours").textContent = durationLabel(totalMinutes(record));
      card.querySelector(".record-km").textContent = `${(totalDistance(record) || 0).toLocaleString("es-ES")} km`;
      card.querySelector(".record-orders").textContent = totalOrders(record).toLocaleString("es-ES");
      const extra = card.querySelector(".record-extra");
      if (record.center === MULTI_CENTER) {
        extra.hidden = false;
        extra.querySelector(".record-extra-detail").textContent = (record.centerLines || []).map((line, index) => {
          const name = line.center === "Otras" ? (line.centerOther || "Otras") : line.center;
          const orders = orderNumber(line.onlineOrders) + orderNumber(line.boxOrders) + orderNumber(line.specialOrders);
          return `${index + 1}. ${name} · ${line.startTime}–${line.endTime} · ${(line.endKm - line.startKm).toLocaleString("es-ES")} km · ${orders.toLocaleString("es-ES")} pedidos`;
        }).join("\n");
      }
      card.querySelector(".record-refuel").textContent = record.refueled === "Sí" ? `Repostaje: ${record.refuelLiters.toLocaleString("es-ES")} L a los ${record.refuelKm.toLocaleString("es-ES")} km` : "Sin repostaje";
      card.querySelector(".record-notes").textContent = record.notes || "";
      card.querySelector(".edit-record").addEventListener("click", () => loadRecord(record));
      card.querySelector(".delete-record").addEventListener("click", () => {
        if (!confirm(`¿Eliminar la jornada del ${displayDate(record.date)}?`)) return;
        records = records.filter(item => item.id !== record.id); saveProtectedRecords(); rememberCloudDeletion(record.id);
        removeCloudRecord(record.id).catch(error => console.warn("La eliminación queda pendiente de sincronizar.", error));
        renderRecords();
      });
      list.append(card);
    }
  }

  function switchView(view) {
    const admin = view === "admin";
    $("workView").hidden = admin; $("adminView").hidden = !admin;
    $("workTabButton").classList.toggle("active", !admin); $("adminTabButton").classList.toggle("active", admin);
    if (admin && adminUnlocked) renderAdmin();
  }
  function renderAdminList(kind, containerId, countId, singular, plural) {
    const container = $(containerId); container.replaceChildren();
    $(countId).textContent = `${lists[kind].length} ${lists[kind].length === 1 ? singular : plural}`;
    for (const value of lists[kind]) {
      const row = document.createElement("div"); row.className = "admin-row";
      const text = document.createElement("span"); text.textContent = value;
      const remove = document.createElement("button"); remove.className = "danger-button"; remove.type = "button"; remove.textContent = "Quitar";
      remove.addEventListener("click", () => {
        if (!confirm(`¿Quitar ${value} de la lista?`)) return;
        lists[kind] = lists[kind].filter(item => item !== value); saveLists();
      });
      row.append(text, remove); container.append(row);
    }
  }
  function renderAdmin() {
    if (!adminUnlocked) return;
    renderAdminList("workers", "adminWorkerList", "adminWorkerCount", "trabajador", "trabajadores");
    renderAdminList("vehicles", "adminVehicleList", "adminVehicleCount", "matrícula", "matrículas");
    renderAdminList("centers", "adminCenterList", "adminCenterCount", "centro", "centros");
  }
  function addListForm(formId, inputId, kind, transform = value => value) {
    $(formId).addEventListener("submit", event => {
      event.preventDefault();
      const value = transform($(inputId).value.trim());
      if (!value) return;
      if (lists[kind].some(item => item.localeCompare(value, "es", { sensitivity: "base" }) === 0)) {
        showMessage($("adminMessage"), "Ese valor ya está en la lista.", true); return;
      }
      lists[kind].push(value); saveLists(); $(inputId).value = "";
      showMessage($("adminMessage"), "Lista actualizada en este dispositivo.");
    });
  }

  function initEvents() {
    $("workTabButton").addEventListener("click", () => switchView("work"));
    $("adminTabButton").addEventListener("click", () => switchView("admin"));
    $("newButton").addEventListener("click", () => {
      if (confirm("¿Limpiar el formulario actual?")) resetForm(true);
    });
    fields.center.addEventListener("change", () => { toggleOtherCenter(); refreshCalculations(); saveDraft(); });
    $("addCenterLine").addEventListener("click", () => { createCenterLine(); refreshCalculations(); saveDraft(); });
    document.querySelectorAll('input[name="refueled"]').forEach(input => input.addEventListener("change", () => { toggleRefuel(); saveDraft(); }));
    $("workForm").addEventListener("input", () => { refreshCalculations(); saveDraft(); });
    $("workForm").addEventListener("change", () => { refreshCalculations(); saveDraft(); });
    $("workForm").addEventListener("submit", async event => {
      event.preventDefault();
      const record = currentRecord();
      const error = validate(record);
      if (error) { showMessage($("formMessage"), error, true); return; }
      const existingIndex = records.findIndex(item => item.id === record.id);
      if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
      try { saveProtectedRecords(); }
      catch (error) {
        showMessage($("formMessage"), "No se pudo guardar la jornada en este móvil. No cierres la aplicación y vuelve a intentarlo.", true);
        console.error("Falló el guardado local.", error); return;
      }
      localStorage.setItem(KEYS.lastWorker, record.worker); localStorage.setItem(KEYS.lastVehicle, record.vehicle);
      if (!lists.workers.some(value => value.localeCompare(record.worker, "es", { sensitivity: "base" }) === 0)) lists.workers.push(record.worker);
      if (!lists.vehicles.includes(record.vehicle)) lists.vehicles.push(record.vehicle);
      saveLists(); renderRecords();
      renderMonthlyDelivery();
      renderMissingDayReminder();
      resetForm(true); showMessage($("formMessage"), "Jornada guardada en el móvil. Copiando en la nube…");
      try {
        await syncRecord(record);
        setCloudStatus("Copia de seguridad en la nube al día.");
        showMessage($("formMessage"), "Jornada guardada en el móvil y en la nube.");
      } catch (error) {
        setCloudStatus("Guardado en el móvil. La copia en la nube está pendiente.", true);
        showMessage($("formMessage"), "Jornada guardada en el móvil. Se copiará en la nube al recuperar conexión.", true);
        console.warn("La jornada queda pendiente de sincronizar.", error);
      }
    });
    $("monthFilter").addEventListener("change", renderRecords);
    $("clearFilter").addEventListener("click", () => { $("monthFilter").value = ""; renderRecords(); });
    $("exportButton").addEventListener("click", () => {
      const month = $("monthFilter").value;
      const selected = records.filter(record => !month || record.date.startsWith(month));
      if (!selected.length) { alert("No hay jornadas para exportar."); return; }
      const suffix = month || "todos";
      window.ExpressXlsx.download(selected, `Erdella-Express-${suffix}.xlsx`, minutesBetween);
    });
    $("monthlyDeliveryButton").addEventListener("click", prepareMonthlyDelivery);
    $("enableNotificationsButton").addEventListener("click", async () => {
      if (!("Notification" in window)) return;
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        $("enableNotificationsButton").hidden = true;
        await showSystemReminder(pendingReminderDates());
      } else {
        $("enableNotificationsButton").textContent = "Avisos bloqueados en Chrome";
        $("enableNotificationsButton").disabled = true;
      }
    });

    $("adminLoginForm").addEventListener("submit", event => {
      event.preventDefault();
      if ($("adminUser").value.trim().toLowerCase() !== ADMIN.user || $("adminPassword").value !== ADMIN.password) {
        showMessage($("adminLoginError"), "Usuario o contraseña de administración incorrectos.", true); return;
      }
      adminUnlocked = true; $("adminLoginForm").hidden = true; $("adminContent").hidden = false; hideMessage($("adminLoginError")); renderAdmin();
    });
    addListForm("addWorkerForm", "newWorker", "workers", value => value.toUpperCase());
    addListForm("addVehicleForm", "newVehicle", "vehicles", value => value.toUpperCase().replace(/\s+/g, ""));
    addListForm("addCenterForm", "newCenter", "centers");
    $("restoreDefaults").addEventListener("click", () => {
      if (!confirm("¿Restaurar las listas originales del Excel?")) return;
      lists = normalizeLists(defaults); saveLists(); showMessage($("adminMessage"), "Listas originales restauradas.");
    });

    const installed = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    $("installButton").hidden = installed;
    window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstall = event; $("installButton").hidden = false; });
    window.addEventListener("appinstalled", () => { deferredInstall = null; $("installButton").hidden = true; });
    window.addEventListener("focus", () => syncExistingRecords().catch(() => {}));
    window.addEventListener("pageshow", () => syncExistingRecords().catch(() => {}));
    window.addEventListener("online", () => syncExistingRecords().catch(() => {}));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncExistingRecords().catch(() => {});
      else saveDraft();
    });
    $("installButton").addEventListener("click", async () => {
      if (deferredInstall) {
        deferredInstall.prompt();
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        if (choice.outcome === "accepted") $("installButton").hidden = true;
        return;
      }
      alert("En Android, abre este enlace en Chrome. Pulsa ⋮, luego «Añadir a pantalla de inicio» y elige «Instalar» si aparece. Si solo ves «Crear acceso directo», puedes añadir un icono sin instalar la app.");
    });
  }

  function init() {
    initAccess(); fillLists(); initEvents();
    initializeCloudSync();
    fields.date.value = today();
    if (!restoreDraft()) resetForm(true);
    renderRecords();
    renderMonthlyDelivery();
    renderMissingDayReminder();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) window.addEventListener("load", async () => {
      await navigator.serviceWorker.register("sw.js");
      showSystemReminder(pendingReminderDates());
    });
  }
  init();
})();
