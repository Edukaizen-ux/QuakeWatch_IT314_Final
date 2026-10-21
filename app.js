
/* LEVEL 1: CONFIGURATION */
const ID_PREFIX = "GLH", LIMIT = 28, RATE = 18;
const PAGE_SIZE = LIMIT, REFRESH_MS = 60000;
const RETRY_DELAY_MS = 1150, MAX_ATTEMPTS = 3;
const STATUS_VALUES = ["Reserved", "Expired", "Suspended"];
const API = {
  hour: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
  day: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
  week: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"
};

/* LEVEL 2: ELEMENTS AND STATE */
const $ = id => document.getElementById(id);
const els = Object.fromEntries([
  "feedSelect", "minMag", "maxMag", "placeSearch", "depthClass",
  "refreshBtn", "message", "alertBanner", "eventCount", "strongest",
  "alertCount", "countdown", "feedDescription", "pageInfo", "quakeTable",
  "prevBtn", "nextBtn", "rangeInfo", "regionList", "changeLog",
  "inspector", "connectionDot", "connectionStatus", "lastUpdated"
].map(id => [id, $(id)]));

let snapshot = [], previousSnapshot = null, filteredEvents = [];
let currentPage = 1, nextNumber = 1, isLoading = false;
let refreshTimer, countdownTimer, requestCount = 0, secondsUntilRefresh = 0;
const eventIds = new Map();

const log = (...a) => console.log("[GLH]", ...a);
const warn = (...a) => console.warn("[GLH]", ...a);
const showMessage = text => els.message.textContent = text;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeId = () => `${ID_PREFIX}-${String(nextNumber++).padStart(4, "0")}`;

function validateStatus(status) {
  if (!STATUS_VALUES.includes(status)) throw Error(`Invalid status: ${status}`);
  return status;
}

function describeStatus(code) {
  if (code === 200) return "OK";
  if (code === 429) return "Too many requests";
  if (code >= 500) return "Server error";
  if (code >= 400) return "Client error";
  return "Network failure";
}

/* LEVEL 3: REQUEST LOGGING */
function logRequest(method, url, status, ok) {
  const empty = els.inspector.querySelector(".inspector-empty");
  if (empty) empty.remove();

  const li = document.createElement("li");
  li.textContent = `#${++requestCount} ${method} ${url} → ${status} ${ok ? "OK" : "Failed"} (${describeStatus(status)})`;
  els.inspector.prepend(li);
}

/* LEVEL 4: API AND RETRIES */
async function fetchFeed(url) {
  let response;

  try {
    response = await fetch(url, {
      headers: { Accept: "application/geo+json, application/json" }
    });

    logRequest("GET", url, response.status, response.ok);
    if (!response.ok) {
      const e = Error(`${response.status}: ${describeStatus(response.status)}`);
      e.kind = "http";
      throw e;
    }

    const body = await response.json();
    if (!Array.isArray(body?.features)) {
      const e = Error("Invalid USGS response: features array missing");
      e.kind = "data";
      throw e;
    }
    return body;
  } catch (e) {
    if (!e.kind) {
      e.kind = response ? "data" : "network";
      if (!response) logRequest("GET", url, 0, false);
    }
    throw e;
  }
}

async function getWithRetry(url) {
  for (let attempt = 1, delay = RETRY_DELAY_MS; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchFeed(url);
    } catch (e) {
      if (e.kind !== "network" || attempt === MAX_ATTEMPTS) throw e;
      warn(`Retry ${attempt} in ${delay} ms`);
      await wait(delay);
      delay *= 2;
    }
  }
}

/* LEVEL 5: DATA PROCESSING */
const depthClass = depth =>
  depth < 70 ? "shallow" : depth <= 300 ? "intermediate" : "deep";

function severityForMagnitude(m) {
  if (m == null || Number.isNaN(m)) return "Unknown";
  return m >= 5 ? "Critical" : m >= 4 ? "High" : m >= 2.5 ? "Moderate" : "Low";
}

const severityClass = s => ({
  Critical: "severity-alert",
  High: "severity-high",
  Moderate: "severity-moderate",
  Low: "severity-low"
})[s] || "severity-low";

function parseFeature(feature) {
  const p = feature.properties || {};
  const coords = feature.geometry?.coordinates || [];
  const depth = Number.isFinite(Number(coords[2])) ? Number(coords[2]) : 0;
  const magnitude = p.mag == null ? null : Number(p.mag);
  const id = feature.id || makeId();

  if (!eventIds.has(id)) eventIds.set(id, makeId());

  return {
    id,
    glhId: eventIds.get(id),
    place: p.place || "Unknown location",
    magnitude,
    depth,
    depthClass: depthClass(depth),
    severity: severityForMagnitude(magnitude),
    status: validateStatus("Reserved"),
    time: p.time || null
  };
}

const applyRate = value => value * (1 + RATE / 100);

/* LEVEL 6: FILTERS AND REGIONS */
function validateFilters() {
  const read = (el, label) => {
    if (!el.value.trim()) return null;
    const n = Number(el.value);
    if (!Number.isFinite(n) || n < 0)
      throw Error(`${label} magnitude must be a valid non-negative number.`);
    return n;
  };

  const min = read(els.minMag, "Minimum");
  const max = read(els.maxMag, "Maximum");
  if (min !== null && max !== null && min > max)
    throw Error("Minimum magnitude cannot be greater than maximum magnitude.");
  return { min, max };
}

function getFiltered() {
  const { min, max } = validateFilters();
  const search = els.placeSearch.value.trim().toLowerCase();
  const depth = els.depthClass.value;

  filteredEvents = snapshot.filter(e =>
    (min === null || (e.magnitude !== null && e.magnitude >= min)) &&
    (max === null || (e.magnitude !== null && e.magnitude <= max)) &&
    (!search || e.place.toLowerCase().includes(search)) &&
    (depth === "all" || e.depthClass === depth)
  );

  currentPage = Math.min(currentPage, Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE)));
}

const regionName = place => place.split(", ").at(-1) || "Unknown region";

function topRegions(events) {
  const counts = {};
  events.forEach(e => {
    const name = regionName(e.place);
    counts[name] = (counts[name] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

/* LEVEL 7: ACTIVITY LOG */
function snapshotDiff(oldData, newData) {
  if (!oldData) return [{ type: "info", text: `Initial snapshot: ${newData.length} event(s).` }];

  const oldMap = new Map(oldData.map(e => [e.id, e]));
  const newMap = new Map(newData.map(e => [e.id, e]));
  const changes = [];

  newData.forEach(e => {
    const old = oldMap.get(e.id);
    if (!old) changes.push({ type: "new", text: `New event: ${e.place} (M${e.magnitude ?? "?"}).` });
    else if (old.magnitude !== e.magnitude)
      changes.push({ type: "revised", text: `Magnitude revised: ${e.place}, ${old.magnitude ?? "?"} → ${e.magnitude ?? "?"}.` });
  });

  oldData.forEach(e => {
    if (!newMap.has(e.id))
      changes.push({ type: "dropped", text: `Dropped from window: ${e.place} (M${e.magnitude ?? "?"}).` });
  });

  const regions = {};
  newData.forEach(e => {
    if (e.magnitude != null && e.magnitude >= 2.5) {
      const name = regionName(e.place);
      regions[name] = (regions[name] || 0) + 1;
    }
  });

  Object.entries(regions).forEach(([name, count]) => {
    if (count >= 3)
      changes.push({ type: "swarm", text: `Swarm flag: ${name} has ${count} events at M2.5+.` });
  });

  return changes.length ? changes : [{ type: "info", text: "No changes detected between snapshots." }];
}

function renderChanges(changes) {
  els.changeLog.textContent = "";
  changes.forEach(c => {
    const div = document.createElement("div");
    div.className = `change-item ${c.type}`;
    div.textContent = c.text;
    els.changeLog.appendChild(div);
  });
  console.table(changes);
}

/* LEVEL 8: DASHBOARD RENDERING */
function render() {
  try {
    getFiltered();
  } catch (e) {
    showMessage(e.message);
    return;
  }

  const total = filteredEvents.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const page = filteredEvents.slice(start, start + PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  els.quakeTable.textContent = "";
  if (!page.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" class="empty-state">No earthquake events match the current filters.</td>';
    els.quakeTable.appendChild(tr);
  }

  page.forEach(e => {
    const tr = document.createElement("tr");
    [
      e.glhId, e.place, e.magnitude == null ? "—" : e.magnitude.toFixed(1),
      `${e.depth.toFixed(1)} km`, e.depthClass, e.severity, e.status
    ].forEach((value, i) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (i === 2 && e.magnitude >= 5) td.className = "mag-high";
      if (i === 5) td.className = `severity ${severityClass(e.severity)}`;
      tr.appendChild(td);
    });
    els.quakeTable.appendChild(tr);
  });

  els.rangeInfo.textContent = total ? `${start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total}` : "0–0 of 0";
  els.pageInfo.textContent = `Page ${currentPage} / ${pageCount}`;
  els.prevBtn.disabled = currentPage <= 1;
  els.nextBtn.disabled = currentPage >= pageCount;
  els.eventCount.textContent = total;

  const mags = filteredEvents.map(e => e.magnitude).filter(m => m != null);
  const strongest = mags.length ? Math.max(...mags) : null;
  const alerts = filteredEvents.filter(e => e.magnitude != null && e.magnitude >= 5).length;

  els.strongest.textContent = strongest == null ? "—" : `M${strongest.toFixed(1)}`;
  els.alertCount.textContent = alerts;
  els.alertBanner.classList.toggle("hidden", alerts === 0);
  els.alertBanner.textContent = alerts ? `Alert: ${alerts} event(s) at magnitude 5.0 or above.` : "";

  els.regionList.textContent = "";
  const regions = topRegions(filteredEvents);
  (regions.length ? regions : [["No regions match the current filters.", ""]]).forEach(([name, count]) => {
    const li = document.createElement("li");
    li.textContent = count === "" ? name : `${name} — ${count} event(s)`;
    els.regionList.appendChild(li);
  });

  els.feedDescription.textContent = `Showing ${total} matching event(s). ${RATE}% named rate metric: ${applyRate(total).toFixed(2)}.`;
}

/* LEVEL 9: AUTO-REFRESH */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  clearInterval(countdownTimer);
  secondsUntilRefresh = REFRESH_MS / 1000;
  els.countdown.textContent = `${secondsUntilRefresh}s`;

  countdownTimer = setInterval(() => {
    els.countdown.textContent = `${Math.max(0, --secondsUntilRefresh)}s`;
  }, 1000);

  refreshTimer = setTimeout(() => {
    clearInterval(countdownTimer);
    loadFeed();
  }, REFRESH_MS);
}

/* LEVEL 10: LOAD FEED AND HANDLE ERRORS */
async function loadFeed() {
  if (isLoading) return;
  isLoading = true;
  els.refreshBtn.disabled = true;
  els.connectionStatus.textContent = "Loading…";
  els.connectionDot.classList.remove("live");

  try {
    const body = await getWithRetry(API[els.feedSelect.value]);
    previousSnapshot = snapshot;
    snapshot = [...new Map(body.features.map(f => {
      const e = parseFeature(f);
      return [e.id, e];
    })).values()];

    showMessage(snapshot.length
      ? `Loaded ${snapshot.length} event(s) successfully.`
      : "The server returned 200 OK with zero features.");

    renderChanges(snapshotDiff(previousSnapshot, snapshot));
    els.connectionStatus.textContent = "Live";
    els.connectionDot.classList.add("live");
    els.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    render();
  } catch (e) {
    console.error("[GLH] Load failed:", e.kind, e.message);
    els.connectionStatus.textContent = "Offline / error";
    showMessage(`Could not load the USGS feed: ${e.message}`);
  } finally {
    isLoading = false;
    els.refreshBtn.disabled = false;
    scheduleRefresh();
  }
}

/* LEVEL 11: EVENTS AND NAVIGATION */
els.refreshBtn.addEventListener("click", loadFeed);
els.feedSelect.addEventListener("change", loadFeed);
[els.minMag, els.maxMag, els.placeSearch, els.depthClass].forEach(el =>
  el.addEventListener("input", render)
);

els.prevBtn.addEventListener("click", () => {
  if (currentPage > 1) currentPage--;
  render();
});

els.nextBtn.addEventListener("click", () => {
  if (currentPage < Math.ceil(filteredEvents.length / PAGE_SIZE)) currentPage++;
  render();
});

document.querySelectorAll(".nav-item").forEach(link => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
    link.classList.add("active");
  });
});

/* LEVEL 12: ASYNC DEMONSTRATION AND INITIALIZATION */
log("step 1: starting a non-awaited request");
fetchFeed(API.hour).then(
  () => log("step 3: response arrived"),
  e => warn("Demonstration request failed:", e.message)
);
log("step 2: request continues asynchronously");

try {
  validateStatus("Invalid");
} catch (e) {
  warn(e.message);
}

render();
loadFeed();
