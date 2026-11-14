import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// ---------- Mapbox setup (Step 1) ----------
mapboxgl.accessToken = 'pk.eyJ1IjoiYW5oMDk0IiwiYSI6ImNtd2ZoeG5xZjAyM24yem9tNm15b2YwZGoifQ.dIvSU0i1YRuiT61yJU-rPg';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12', // or your custom style URL
  center: [-71.09415, 42.36027], // [lng, lat]
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// Shared style for both bike lane layers (Step 2)
const bikeLaneStyle = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.6,
};

// ---------- Global state and helpers ----------

// Trips bucketed by minute of the day (Step 5.4)
const departuresByMinute = Array.from({ length: 1440 }, () => []);
const arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// lon/lat -> pixel position on the map (Step 3.3)
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Minutes since midnight -> "9:29 AM" (Step 5.2)
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Trips within 60 minutes before/after `minute`, using the prebuilt buckets
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // no filtering
  }

  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    // window crosses midnight
    const beforeMidnight = tripsByMinute.slice(minMinute);
    const afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

// Arrivals, departures, and total traffic per station (Steps 4.2, 5.3, 5.4)
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// Quantize scale: any ratio in [0, 1] snaps to 0, 0.5, or 1 (Step 6.1)
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

function departureRatio(d) {
  // guard against 0/0 when a station has no trips in the filtered window
  return d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5;
}

// ---------- Everything that needs the map to be loaded ----------
map.on('load', async () => {
  // --- Bike lanes (Steps 2.1 to 2.3) ---
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'boston-bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: bikeLaneStyle,
  });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'PASTE_CAMBRIDGE_GEOJSON_URL_HERE',
  });
  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLaneStyle,
  });

  const svg = d3.select('#map').select('svg');

  // --- Stations (Step 3.1) ---
  let jsonData;
  try {
    jsonData = await d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json');
  } catch (error) {
    console.error('Error loading stations:', error);
    return;
  }

  // --- Trips (Steps 4.1, 5.3, 5.4): parse dates and fill minute buckets as rows load ---
  try {
    await d3.csv(
      'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
      (trip) => {
        trip.started_at = new Date(trip.started_at);
        trip.ended_at = new Date(trip.ended_at);

        departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
        arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);

        return trip;
      },
    );
  } catch (error) {
    console.error('Error loading trips:', error);
    return;
  }

  const stations = computeStationTraffic(jsonData.data.stations);
  console.log('Stations with traffic:', stations);

  // --- Circle size: sqrt scale so AREA tracks traffic (Step 4.3) ---
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // --- Circles (Steps 3.3, 4.3, 4.4, 6.1) ---
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', departureRatio)
    .each(function () {
      d3.select(this).append('title'); // text filled in by updateTooltips()
    });

  function updateTooltips() {
    circles
      .select('title')
      .text(
        (d) => `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
      );
  }
  updateTooltips();

  // Keep circles aligned with the map as it moves (Step 3.3)
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // --- Time slider (Steps 5.2, 5.3) ---
  const timeSlider = document.getElementById('time-slider'); // no '#' with getElementById
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // Bigger circles when filtering, since there are fewer trips
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', departureRatio);

    updateTooltips();
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});