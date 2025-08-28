let map;
let markers = [];
let infoWindow;
let currentDetailMarker = null;

// Limites aproximados de México (para restringir el viewport)
const MEXICO_BOUNDS = {
  north: 33.0,
  south: 14.0,
  west: -118.5,
  east: -86.5,
};

window.addEventListener("load", async () => {
  await initMap();
});

async function initMap() {
  const center = { lat: 23.6345, lng: -102.5528 };

  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  // Crear mapa full-screen
  map = new Map(document.getElementById("map"), {
    center,
    zoom: 5,
    mapId: "DEMO_MAP_ID",
    restriction: {
      latLngBounds: MEXICO_BOUNDS,
      strictBounds: true,
    },
    // UI minimalista
    fullscreenControl: false,
    streetViewControl: false,
    mapTypeControl: false,
  });

  // Limitar el panning fuera de México (seguridad extra)
  map.addListener("dragend", () => {
    const c = map.getCenter();
    const lat = Math.min(
      Math.max(c.lat(), MEXICO_BOUNDS.south),
      MEXICO_BOUNDS.north
    );
    const lng = Math.min(
      Math.max(c.lng(), MEXICO_BOUNDS.west),
      MEXICO_BOUNDS.east
    );
    if (lat !== c.lat() || lng !== c.lng()) map.setCenter({ lat, lng });
  });

  infoWindow = new google.maps.InfoWindow();

  await loadHouses();

  // Actualizar visibilidad con movimiento/zoom
  map.addListener("idle", updateMarkersVisibility);
  map.addListener("zoom_changed", updateMarkersVisibility);

  // Crear nueva nota con click (solo si estás dentro del radio desde el centro)
  map.addListener("click", (event) => {
    const pos = event.latLng;
    const center = map.getCenter();
    const dist = haversineMeters(
      center.lat(),
      center.lng(),
      pos.lat(),
      pos.lng()
    );
    if (dist > PROXIMITY_RADIUS_METERS) {
      //alert("Debes acercarte más para agregar una nota en ese lugar.");
      return;
    }
    openCreateForm(pos);
  });
}

function createMarker(position, address, description, id = null) {
  // Chip visual para el marcador
  const chip = document.createElement("div");
  chip.className = "marker-chip";
  const emoji = document.createElement("span");
  emoji.className = "emoji";
  emoji.textContent = "🏠";
  const text = document.createElement("span");
  text.textContent = address ? trimText(address, 18) : "Nueva nota";
  chip.appendChild(emoji);
  chip.appendChild(text);

  const marker = new google.maps.marker.AdvancedMarkerElement({
    map,
    position,
    content: chip,
  });

  marker.address = address;
  marker.description = description;
  marker.id = id;

  // Guardamos la lat/lng como números para calcular distancias
  marker.lat =
    typeof position.lat === "function" ? position.lat() : position.lat;
  marker.lng =
    typeof position.lng === "function" ? position.lng() : position.lng;

  marker.addListener("click", () => {
    currentDetailMarker = marker;
    openDetail(marker);
  });

  return marker;
}

async function loadHouses() {
  try {
    const response = await fetch("/api/houses");
    const houses = await response.json();

    houses.forEach((house) => {
      const position = new google.maps.LatLng(house.lat, house.lng);
      const marker = createMarker(
        position,
        house.address,
        house.description,
        house.id
      );
      markers.push(marker);
    });

    // Ajustar visibilidad inicial
    updateMarkersVisibility();
  } catch (error) {
    console.error("Error loading houses:", error);
  }
}

function openDetail(marker) {
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">${escapeHtml(marker.address || "Sin dirección")}</div>
    <div class="desc">${escapeHtml(
      marker.description || "Sin descripción"
    )}</div>
  `;

  infoWindow.setContent(content);
  infoWindow.setPosition(marker.position);

  // Mostrar un poco más arriba (hacia arriba = valor negativo en Y)
  infoWindow.setOptions({
    pixelOffset: new google.maps.Size(0, -30),
  });

  infoWindow.open({ map });
}

function openCreateForm(position) {
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">Nueva nota</div>
    <div class="quick-form large" style="padding: 4px;">
      <input id="addr" type="text" placeholder="Título" maxlength="70" />
      <textarea id="desc" placeholder="Descripción"></textarea>
      <div class="actions">
        <button class="primary" id="save">Guardar</button>
      </div>
    </div>
  `;

  infoWindow.setContent(content);
  infoWindow.setPosition(position);
  infoWindow.open({ map });

  // Auto-expand del textarea para evitar scroll
  const descEl = content.querySelector("#desc");
  const autoResize = (el) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };
  descEl.addEventListener("input", () => autoResize(descEl));
  // inicializar por si hay texto pegado
  setTimeout(() => autoResize(descEl), 0);

  content.querySelector("#save").addEventListener("click", async () => {
    const address = content.querySelector("#addr").value.trim();
    const description = content.querySelector("#desc").value.trim();
    if (!address || !description) return;

    try {
      const houseData = {
        address,
        description,
        lat: position.lat(),
        lng: position.lng(),
      };

      const resp = await fetch("/api/houses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(houseData),
      });

      if (!resp.ok) throw new Error(await resp.text());
      const newHouse = await resp.json();

      const marker = createMarker(position, address, description, newHouse.id);
      markers.push(marker);
      // Centrar al nuevo marcador y actualizar visibilidad
      map.setCenter(position);
      updateMarkersVisibility();
      openDetail(marker);
    } catch (e) {
      console.error("Error saving house:", e);
    }
  });
}

function openEditForm(marker) {
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">Editar nota</div>
    <div class="meta">Lat: ${formatCoord(
      marker.position.lat
    )} · Lng: ${formatCoord(marker.position.lng)}</div>
    <div class="quick-form">
      <input id="addr" type="text" value="${escapeAttr(
        marker.address || ""
      )}" />
      <textarea id="desc">${escapeHtml(marker.description || "")}</textarea>
      <div class="actions">
        <button class="primary" id="update">Actualizar</button>
      </div>
    </div>
  `;

  infoWindow.setContent(content);
  infoWindow.setPosition(marker.position);
  infoWindow.open({ map });

  content.querySelector("#update").addEventListener("click", async () => {
    const address = content.querySelector("#addr").value.trim();
    const description = content.querySelector("#desc").value.trim();
    if (!address || !description) return;

    try {
      const resp = await fetch(`/api/houses/${marker.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, description }),
      });
      if (!resp.ok) throw new Error(await resp.text());

      marker.address = address;
      marker.description = description;
      openDetail(marker);
    } catch (e) {
      console.error("Error updating house:", e);
    }
  });
}

async function deleteHouse(id) {
  if (!id) return;
  if (!confirm("¿Eliminar esta nota?")) return;

  try {
    const resp = await fetch(`/api/houses/${id}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(await resp.text());

    const idx = markers.findIndex((m) => m.id === id);
    if (idx !== -1) {
      markers[idx].map = null; // remove from map
      markers.splice(idx, 1);
    }
    infoWindow.close();
  } catch (e) {
    console.error("Error deleting house:", e);
  }
}

// Configuración de proximidad (en metros)
const PROXIMITY_RADIUS_METERS = 3000; // 3 km por defecto, ajústalo si quieres más/menos

// Helpers
function trimText(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
function formatCoord(fn) {
  // supports both number and function lat()/lng()
  const v = typeof fn === "function" ? fn() : fn;
  return Number(v).toFixed(4);
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// Distancia Haversine (metros)
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // radio tierra en m
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Actualiza visibilidad de marcadores según distancia al centro del mapa
function updateMarkersVisibility() {
  if (!map) return;
  const center = map.getCenter();
  const cLat = center.lat();
  const cLng = center.lng();

  // Cerrar detalle si el marcador activo sale de rango
  let shouldCloseInfo = false;

  markers.forEach((m) => {
    const dist = haversineMeters(cLat, cLng, m.lat, m.lng);
    const visible = dist <= PROXIMITY_RADIUS_METERS;

    // Mostrar/ocultar AdvancedMarkerElement
    m.map = visible ? map : null;

    if (!visible && currentDetailMarker && m === currentDetailMarker) {
      shouldCloseInfo = true;
    }
  });

  if (shouldCloseInfo) {
    infoWindow.close();
    currentDetailMarker = null;
  }
}

// Manejo de error de Google Maps API
window.gm_authFailure = function () {
  alert("Error al cargar Google Maps. Verifique su clave API.");
};
