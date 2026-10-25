
/* =========================================================
   QUAKE WATCH — IT 314 MIDTERM PROJECT
   GLH • Live Seismic Monitor
   ========================================================= */

/* LEVEL 1: CONFIGURATION */

const ID_PREFIX = "GLH";
const LIMIT = 28;
const RATE = 18;
const PAGE_SIZE = LIMIT;
const REFRESH_MS = 60000;
const RETRY_DELAY_MS = 1150;
const MAX_ATTEMPTS = 3;

const STATUS_VALUES = ["Reserved", "Expired", "Suspended"];

const API = {
  hour: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
  day: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
  week: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"
};

/* LEVEL 2: DOM ELEMENTS AND STATE */

const $ = id => document.getElementById(id);

const els = Object.fromEntries([
  "feedSelect", "minMag", "maxMag", "placeSearch", "depthClass",
  "refreshBtn", "message", "alertBanner", "eventCount", "strongest",
  "alertCount", "countdown", "feedDescription", "pageInfo", "quakeTable",
  "prevBtn", "nextBtn", "rangeInfo", "regionList", "changeLog",
  "inspector", "connectionDot", "connectionStatus", "lastUpdated"
].map(id => [id, $(id)]));

let snapshot = [];
let previousSnapshot = null;
let filteredEvents = [];
let currentPage = 1;
let nextNumber = 1;
let isLoading = false;
let refreshTimer;
let countdownTimer;
let requestCount = 0;
let secondsUntilRefresh = 0;

const eventIds = new Map();

const log = (...args) => console.log("[GLH]", ...args);
const warn = (...args) => console.warn("[GLH]", ...args);
const showMessage = message => {
  els.message.textContent = message;
};

/* UC-6 and UC-9: PROMISE-BASED WAIT
   Returns a Promise that resolves after the requested delay. */

const wait = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const makeId = () =>
  `${ID_PREFIX}-${String(nextNumber++).padStart(4, "0")}`;


/* =========================================================
   UC-3: SWITCH AND IF / ELSE IF / ELSE
   UC-4: STATUS DESCRIPTION
   ========================================================= */

function validateStatus(status) {
  if (!STATUS_VALUES.includes(status)) {
    throw Error(`Invalid status: ${status}`);
  }

  return status;
}

/* UC-4: DESCRIBE HTTP STATUS
   Handles 200, 400, 404, 500, and default cases. */

function describeStatus(code) {
  switch (Number(code)) {
    case 200:
      return "OK";

    case 400:
      return "Bad request";

    case 404:
      return "Not found";

    case 500:
      return "Internal server error";

    default:
      if (Number(code) === 0) {
        return "Network failure";
      } else if (code >= 400 && code < 500) {
        return "Client error";
      } else if (code >= 500) {
        return "Server error";
      } else {
        return "Unknown or informational status";
      }
  }
}


/* =========================================================
   UC-4: NETWORK INSPECTOR
   UC-7: DYNAMIC EVENT LISTENER
   UC-11: SAFE DOM CREATION
   ========================================================= */

/* Records request number, method, URL, HTTP status,
   response.ok, and a human-readable status description. */

function logRequest(method, url, status, ok) {
  const empty = els.inspector.querySelector(".inspector-empty");

  if (empty) {
    empty.remove();
  }

  const li = document.createElement("li");
  const description = describeStatus(status);

  li.textContent =
    `#${++requestCount} ${method} ${url} → ${status} ` +
    `${ok ? "OK" : "Failed"} (${description})`;

  li.title = "Click to view request details";

  /* UC-7: Listener on a dynamically created element.
     The event object identifies the clicked list item. */

  li.addEventListener("click", function (event) {
    const item = event.currentTarget;
    const existing = item.querySelector(".request-detail");

    if (existing) {
      existing.remove();
    } else {
      const detail = document.createElement("span");
      detail.className = "request-detail";
      detail.textContent =
        `Method: ${method}; URL: ${url}; status: ${status}; ` +
        `response.ok: ${ok}; message: ${description}`;

      item.appendChild(detail);
    }
  });

  els.inspector.prepend(li);
}


/* =========================================================
   UC-5: CENTRALIZED API REQUEST
   UC-9: ASYNC / AWAIT AND TRY / CATCH
   ========================================================= */

/* UC-5: apiGet(url) contains the only fetch() call.
   It awaits the response, checks response.ok, parses JSON,
   validates the returned data, and handles errors. */

async function apiGet(url) {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/geo+json, application/json"
      }
    });

    logRequest("GET", url, response.status, response.ok);

    if (!response.ok) {
      const error = Error(
        `${response.status}: ${describeStatus(response.status)}`
      );

      error.kind = "http";
      throw error;
    }

    const body = await response.json();

    if (!Array.isArray(body?.features)) {
      const error = Error(
        "Invalid USGS response: features array missing"
      );

      error.kind = "data";
      throw error;
    }

    return body;
  } catch (error) {
    if (!error.kind) {
      error.kind = response ? "data" : "network";

      if (!response) {
        logRequest("GET", url, 0, false);
      }
    }

    throw error;
  }
}


/* =========================================================
   UC-3 AND UC-6: WHILE LOOP AND RETRY MECHANISM
   ========================================================= */

/* Retries network failures up to MAX_ATTEMPTS.
   The waiting period doubles after each retry. */

async function getWithRetry(url) {
  let attempt = 0;
  let delay = RETRY_DELAY_MS;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;

    try {
      return await apiGet(url);
    } catch (error) {
      if (
        error.kind !== "network" ||
        attempt >= MAX_ATTEMPTS
      ) {
        throw error;
      }

      warn(`Retry ${attempt} in ${delay} ms`);

      await wait(delay);
      delay *= 2;
    }
  }

  throw Error(
    "The request could not be completed after three attempts."
  );
}


/* =========================================================
   LEVEL 5: EARTHQUAKE DATA PROCESSING
   UC-3: IF / ELSE IF / ELSE
   UC-10: ARROW FUNCTIONS
   ========================================================= */

const depthClass = depth =>
  depth < 70
    ? "shallow"
    : depth <= 300
      ? "intermediate"
      : "deep";

function severityForMagnitude(magnitude) {
  if (magnitude == null || Number.isNaN(magnitude)) {
    return "Unknown";
  } else if (magnitude >= 5) {
    return "Critical";
  } else if (magnitude >= 4) {
    return "High";
  } else if (magnitude >= 2.5) {
    return "Moderate";
  } else {
    return "Low";
  }
}

const severityClass = severity => ({
  Critical: "severity-alert",
  High: "severity-high",
  Moderate: "severity-moderate",
  Low: "severity-low"
})[severity] || "severity-low";


function parseFeature(feature) {
  const properties = feature.properties || {};
  const coordinates = feature.geometry?.coordinates || [];

  const depth = Number.isFinite(Number(coordinates[2]))
    ? Number(coordinates[2])
    : 0;

  const magnitude =
    properties.mag == null ? null : Number(properties.mag);

  const id = feature.id || makeId();

  if (!eventIds.has(id)) {
    eventIds.set(id, makeId());
  }

  return {
    id,
    glhId: eventIds.get(id),
    place: properties.place || "Unknown location",
    magnitude,
    depth,
    depthClass: depthClass(depth),
    severity: severityForMagnitude(magnitude),
    status: validateStatus("Reserved"),
    time: properties.time || null
  };
}

const applyRate = value =>
  value * (1 + RATE / 100);


/* =========================================================
   LEVEL 6: FILTERS AND REGIONS
   UC-10: ARRAY AND STRING METHODS
   ========================================================= */

function validateFilters() {
  const read = (element, label) => {
    if (!element.value.trim()) {
      return null;
    }

    const number = Number(element.value);

    if (!Number.isFinite(number) || number < 0) {
      throw Error(
        `${label} magnitude must be a valid non-negative number.`
      );
    }

    return number;
  };

  const min = read(els.minMag, "Minimum");
  const max = read(els.maxMag, "Maximum");

  if (min !== null && max !== null && min > max) {
    throw Error(
      "Minimum magnitude cannot be greater than maximum magnitude."
    );
  }

  return { min, max };
}


/* UC-10: filter(), trim(), toLowerCase(), includes() */

function getFiltered() {
  const { min, max } = validateFilters();
  const search = els.placeSearch.value.trim().toLowerCase();
  const depth = els.depthClass.value;

  filteredEvents = snapshot.filter(event =>
    (min === null ||
      (event.magnitude !== null && event.magnitude >= min)) &&
    (max === null ||
      (event.magnitude !== null && event.magnitude <= max)) &&
    (!search || event.place.toLowerCase().includes(search)) &&
    (depth === "all" || event.depthClass === depth)
  );

  currentPage = Math.min(
    currentPage,
    Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE))
  );
}


/* UC-10: split() and at() */

const regionName = place =>
  place.split(", ").at(-1) || "Unknown region";


/* UC-10: reduce(), Object.entries(), sort(), slice() */

function topRegions(events) {
  const counts = events.reduce((result, event) => {
    const name = regionName(event.place);

    result[name] = (result[name] || 0) + 1;

    return result;
  }, {});

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}


/* =========================================================
   LEVEL 7: ACTIVITY LOG
   UC-10: map(), forEach(), push()
   UC-11: DOM RENDERING WITHOUT innerHTML
   ========================================================= */

function snapshotDiff(oldData, newData) {
  if (!oldData) {
    return [{
      type: "info",
      text: `Initial snapshot: ${newData.length} event(s).`
    }];
  }

  const oldMap = new Map(oldData.map(event => [event.id, event]));
  const newMap = new Map(newData.map(event => [event.id, event]));
  const changes = [];

  newData.forEach(event => {
    const old = oldMap.get(event.id);

    if (!old) {
      changes.push({
        type: "new",
        text:
          `New event: ${event.place} ` +
          `(M${event.magnitude ?? "?"}).`
      });
    } else if (old.magnitude !== event.magnitude) {
      changes.push({
        type: "revised",
        text:
          `Magnitude revised: ${event.place}, ` +
          `${old.magnitude ?? "?"} → ${event.magnitude ?? "?"}.`
      });
    }
  });

  oldData.forEach(event => {
    if (!newMap.has(event.id)) {
      changes.push({
        type: "dropped",
        text:
          `Dropped from window: ${event.place} ` +
          `(M${event.magnitude ?? "?"}).`
      });
    }
  });

  const regions = {};

  newData.forEach(event => {
    if (
      event.magnitude != null &&
      event.magnitude >= 2.5
    ) {
      const name = regionName(event.place);
      regions[name] = (regions[name] || 0) + 1;
    }
  });

  Object.entries(regions).forEach(([name, count]) => {
    if (count >= 3) {
      changes.push({
        type: "swarm",
        text: `Swarm flag: ${name} has ${count} events at M2.5+.`
      });
    }
  });

  return changes.length
    ? changes
    : [{
        type: "info",
        text: "No changes detected between snapshots."
      }];
}


/* UC-11: Clears and rebuilds the activity log safely.
   Uses textContent, createElement(), and appendChild(). */

function renderChanges(changes) {
  els.changeLog.textContent = "";

  changes.forEach(change => {
    const div = document.createElement("div");

    div.className = `change-item ${change.type}`;
    div.textContent = change.text;

    els.changeLog.appendChild(div);
  });

  console.table(changes);
}


/* =========================================================
   LEVEL 8: DASHBOARD RENDERING
   UC-3: FOR LOOP
   UC-10: ARRAY METHODS AND TEMPLATE LITERALS
   UC-11: SAFE DOM RENDERING
   ========================================================= */

function render() {
  try {
    getFiltered();
  } catch (error) {
    showMessage(error.message);
    return;
  }

  const total = filteredEvents.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const page = filteredEvents.slice(start, start + PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /* UC-11: Clear the table without using innerHTML. */

  els.quakeTable.textContent = "";

  if (!page.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");

    td.colSpan = 7;
    td.className = "empty-state";
    td.textContent =
      "No earthquake events match the current filters.";

    tr.appendChild(td);
    els.quakeTable.appendChild(tr);
  }

  /* UC-3: Explicit for loop over the current page. */

  for (let index = 0; index < page.length; index++) {
    const event = page[index];
    const tr = document.createElement("tr");

    const values = [
      event.glhId,
      event.place,
      event.magnitude == null
        ? "—"
        : event.magnitude.toFixed(1),
      `${event.depth.toFixed(1)} km`,
      event.depthClass,
      event.severity,
      event.status
    ];

    values.forEach((value, cellIndex) => {
      const td = document.createElement("td");

      td.textContent = value;

      if (cellIndex === 2 && event.magnitude >= 5) {
        td.className = "mag-high";
      }

      if (cellIndex === 5) {
        td.className =
          `severity ${severityClass(event.severity)}`;
      }

      tr.appendChild(td);
    });

    els.quakeTable.appendChild(tr);
  }

  els.rangeInfo.textContent = total
    ? `${start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total}`
    : "0–0 of 0";

  els.pageInfo.textContent = `Page ${currentPage} / ${pageCount}`;
  els.prevBtn.disabled = currentPage <= 1;
  els.nextBtn.disabled = currentPage >= pageCount;
  els.eventCount.textContent = total;

  const magnitudes = filteredEvents
    .map(event => event.magnitude)
    .filter(magnitude => magnitude != null);

  const strongest = magnitudes.length
    ? Math.max(...magnitudes)
    : null;

  const alerts = filteredEvents.filter(event =>
    event.magnitude != null && event.magnitude >= 5
  ).length;

  els.strongest.textContent =
    strongest == null ? "—" : `M${strongest.toFixed(1)}`;

  els.alertCount.textContent = alerts;

  els.alertBanner.classList.toggle("hidden", alerts === 0);

  els.alertBanner.textContent = alerts
    ? `Alert: ${alerts} event(s) at magnitude 5.0 or above.`
    : "";

  els.regionList.textContent = "";

  const regions = topRegions(filteredEvents);

  const displayedRegions = regions.length
    ? regions
    : [["No regions match the current filters.", ""]];

  displayedRegions.forEach(([name, count]) => {
    const item = document.createElement("li");

    item.textContent = count === ""
      ? name
      : `${name} — ${count} event(s)`;

    els.regionList.appendChild(item);
  });

  els.feedDescription.textContent =
    `Showing ${total} matching event(s). ` +
    `${RATE}% named rate metric: ${applyRate(total).toFixed(2)}.`;
}


/* =========================================================
   LEVEL 9: AUTO-REFRESH
   ========================================================= */

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  clearInterval(countdownTimer);

  secondsUntilRefresh = REFRESH_MS / 1000;
  els.countdown.textContent = `${secondsUntilRefresh}s`;

  countdownTimer = setInterval(() => {
    els.countdown.textContent =
      `${Math.max(0, --secondsUntilRefresh)}s`;
  }, 1000);

  refreshTimer = setTimeout(() => {
    clearInterval(countdownTimer);
    loadFeed();
  }, REFRESH_MS);
}


/* =========================================================
   UC-8: LOADING GUARD AND PAGE STATES
   UC-9: ASYNC / AWAIT
   ========================================================= */

/* isLoading prevents overlapping requests.
   The function updates the connection and error states. */

async function loadFeed() {
  if (isLoading) {
    return;
  }

  isLoading = true;
  els.refreshBtn.disabled = true;
  els.connectionStatus.textContent = "Loading…";
  els.connectionDot.classList.remove("live");

  try {
    const body = await getWithRetry(API[els.feedSelect.value]);

    previousSnapshot = snapshot;

    snapshot = [
      ...new Map(body.features.map(feature => {
        const event = parseFeature(feature);
        return [event.id, event];
      })).values()
    ];

    showMessage(
      snapshot.length
        ? `Loaded ${snapshot.length} event(s) successfully.`
        : "The server returned 200 OK with zero features."
    );

    renderChanges(snapshotDiff(previousSnapshot, snapshot));

    els.connectionStatus.textContent = "Live";
    els.connectionDot.classList.add("live");
    els.lastUpdated.textContent =
      `Updated ${new Date().toLocaleTimeString()}`;

    render();
  } catch (error) {
    console.error(
      "[GLH] Load failed:",
      error.kind,
      error.message
    );

    els.connectionStatus.textContent = "Offline / error";

    showMessage(
      `Could not load the USGS feed: ${error.message}`
    );
  } finally {
    isLoading = false;
    els.refreshBtn.disabled = false;
    scheduleRefresh();
  }
}


/* =========================================================
   UC-7: EVENT LISTENERS
   Uses click, change, input, and keydown event types.
   ========================================================= */

els.refreshBtn.addEventListener("click", loadFeed);
els.feedSelect.addEventListener("change", loadFeed);

[els.minMag, els.maxMag, els.placeSearch, els.depthClass]
  .forEach(element => {
    element.addEventListener("input", render);
  });

els.prevBtn.addEventListener("click", function () {
  if (currentPage > 1) {
    currentPage--;
  }

  render();
});

els.nextBtn.addEventListener("click", () => {
  if (currentPage < Math.ceil(filteredEvents.length / PAGE_SIZE)) {
    currentPage++;
  }

  render();
});

document.querySelectorAll(".nav-item").forEach(link => {
  link.addEventListener("click", event => {
    document.querySelectorAll(".nav-item").forEach(item => {
      item.classList.remove("active");
    });

    event.currentTarget.classList.add("active");
  });
});

/* UC-7: Uses the event object for keyboard interaction. */

els.placeSearch.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    render();
  }
});


/* =========================================================
   UC-9: .then(), .catch(), AND PROMISE
   UC-10: ARRAY MUTATION AND STRING METHODS
   ========================================================= */

/* Demonstrates a Promise chain with .then() and .catch().
   This also logs request information in the Network Inspector. */

log("step 1: starting a non-awaited request");

apiGet(API.hour)
  .then(() => log("step 3: response arrived"))
  .catch(error => {
    warn("Demonstration request failed:", error.message);
  });

log("step 2: request continues asynchronously");


/* UC-10: Array mutation methods.
   These operate on a separate demonstration array and do not
   change the earthquake data. */

const initializationNotes = ["configuration loaded"];

initializationNotes.push("event handlers ready");
initializationNotes.unshift("GLH");
initializationNotes.splice(1, 1, "dashboard initialized");

if (initializationNotes.length > 3) {
  initializationNotes.pop();
}

if (initializationNotes.length > 0) {
  initializationNotes.shift();
}


/* UC-10: String methods and template literal. */

const normalizedProjectName =
  " Quake Watch ".trim().toLowerCase();

const projectWords = normalizedProjectName.split(" ");

const projectLabel =
  `${projectWords[0].toUpperCase()} ${projectWords.at(-1)}`;

log(`Project initialized: ${projectLabel}`);


/* UC-10: Function expression and array filtering. */

const getCriticalEvents = function (events) {
  return events.filter(event =>
    event.magnitude != null && event.magnitude >= 5
  );
};


/* Demonstrates status validation and console.warn(). */

try {
  validateStatus("Invalid");
} catch (error) {
  warn(error.message);
}


/* =========================================================
   UC-12: CONSOLE OUTPUT
   Uses log(), warn(), error(), and table() in the application.
   ========================================================= */


/* LEVEL 17: INITIALIZATION */

render();
loadFeed();
