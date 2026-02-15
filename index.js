const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3001;

// Configure CORS to allow your frontend domain
const allowedOrigins = [
  'https://busapp-frontend-eight.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Cache for bus stop data
let busStopsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Cache for bus arrival data
const arrivalCache = new Map();
const ARRIVAL_CACHE_DURATION = 15000; // 15 seconds

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

// Helper function to fetch single bus stop arrival with caching
async function fetchBusArrival(busStopCode, apiKey) {
  // Check cache first
  const cacheKey = busStopCode;
  const cached = arrivalCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < ARRIVAL_CACHE_DURATION)) {
    return { data: cached.data, cached: true };
  }

  // Fetch fresh data from API
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
    throw new Error(`API Error: ${arrivalResponse.status} ${arrivalResponse.statusText} - ${errorText}`);
  }

  const arrivalData = await arrivalResponse.json();
  
  // Cache the response
  arrivalCache.set(cacheKey, {
    data: arrivalData,
    timestamp: Date.now()
  });

  return { data: arrivalData, cached: false };
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
    const result = await fetchBusArrival(busStopCode, apiKey);
    res.json(result.data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch endpoint for fetching multiple bus stops at once
app.post('/api/bus-arrival-batch', async (req, res) => {
  const { busStopCodes, apiKey } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  if (!busStopCodes || !Array.isArray(busStopCodes) || busStopCodes.length === 0) {
    return res.status(400).json({ error: 'busStopCodes array is required' });
  }

  // Limit batch size to prevent abuse
  if (busStopCodes.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 bus stops per batch request' });
  }

  try {
    // Fetch all bus stops in parallel with rate limiting (3 at a time)
    const results = [];
    const CONCURRENT_LIMIT = 50;
    
    for (let i = 0; i < busStopCodes.length; i += CONCURRENT_LIMIT) {
      const batch = busStopCodes.slice(i, i + CONCURRENT_LIMIT);
      const batchResults = await Promise.allSettled(
        batch.map(async (code) => {
          try {
            const result = await fetchBusArrival(code, apiKey);
            return {
              busStopCode: code,
              data: result.data,
              cached: result.cached,
              success: true
            };
          } catch (error) {
            return {
              busStopCode: code,
              error: error.message,
              success: false
            };
          }
        })
      );
      
      // Extract values from settled promises
      results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : r.reason));
    }

    res.json({ results });
  } catch (error) {
    console.error('Batch proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});

// Export for Vercel serverless
module.exports = app;
