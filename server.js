const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Cache for bus stop data
let busStopsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Function to fetch all bus stops with pagination
async function fetchAllBusStops(apiKey) {
  const allBusStops = [];
  let skip = 0;
  const batchSize = 500;
  
  try {
    while (true) {
      const response = await fetch(
        `https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`,
        {
          method: 'GET',
          headers: {
            'AccountKey': apiKey,
            'accept': 'application/json'
          }
        }
      );

      if (!response.ok) {
        console.error(`Failed to fetch bus stops at skip=${skip}`);
        break;
      }

      const data = await response.json();
      
      if (!data.value || data.value.length === 0) {
        break;
      }

      allBusStops.push(...data.value);
      
      // If we got less than 500 records, we've reached the end
      if (data.value.length < batchSize) {
        break;
      }

      skip += batchSize;
    }

    console.log(`Fetched ${allBusStops.length} bus stops`);
    return allBusStops;
  } catch (error) {
    console.error('Error fetching bus stops:', error);
    return [];
  }
}

// Function to get bus stops (with caching)
async function getBusStops(apiKey) {
  const now = Date.now();
  
  // Return cached data if it's still valid
  if (busStopsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
    return busStopsCache;
  }

  // Fetch fresh data
  const busStops = await fetchAllBusStops(apiKey);
  busStopsCache = busStops;
  cacheTimestamp = now;
  
  return busStops;
}

app.get('/api/bus-arrival', async (req, res) => {
  const { busStopCode, apiKey } = req.query;

  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  if (!busStopCode) {
    return res.status(400).json({ error: 'Bus stop code is required' });
  }

  try {
    // Fetch bus arrival data
    const arrivalResponse = await fetch(
      `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${busStopCode}`,
      {
        method: 'GET',
        headers: {
          'AccountKey': apiKey,
          'accept': 'application/json'
        }
      }
    );

    if (!arrivalResponse.ok) {
      const errorText = await arrivalResponse.text();
      return res.status(arrivalResponse.status).json({ 
        error: `API Error: ${arrivalResponse.status} ${arrivalResponse.statusText}`,
        details: errorText
      });
    }

    const arrivalData = await arrivalResponse.json();
    
    // Fetch bus stop details for the name
    try {
      const busStops = await getBusStops(apiKey);
      const busStopInfo = busStops.find(stop => stop.BusStopCode === busStopCode);
      if (busStopInfo) {
        arrivalData.BusStopName = busStopInfo.Description;
      }
    } catch (err) {
      // Ignore errors fetching bus stop name
      console.error('Error fetching bus stop name:', err);
    }
    
    res.json(arrivalData);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});
