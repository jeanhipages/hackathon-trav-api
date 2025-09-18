const express = require('express');
const OpenAI = require('openai');
const { Client } = require('@googlemaps/google-maps-services-js');
const { bunningsLocation } = require('./data.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Google Maps client
const googleMapsClient = new Client({});

app.use(express.json());

// Note: Schedule is now passed in requests rather than stored server-side

app.get('/hello-world', (req, res) => {
  res.json({
    message: 'Hello World!',
    timestamp: new Date().toISOString()
  });
});

// Chat endpoint for schedule management
app.post('/chat', async (req, res) => {
  try {
    const { message, conversationHistory = [], schedule = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // System prompt for the schedule management chatbot
    const systemPrompt = `You are an intelligent schedule management assistant. The user has a daily schedule with appointments and tasks. Your job is to help them modify their schedule by adding new tasks.

Current Schedule:
${schedule.map(task => {
      const startTime = new Date(task.startDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const endTime = new Date(task.endDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `- ${startTime}-${endTime}: ${task.title} at ${task.location?.formattedAddress || 'Location TBD'}`;
    }).join('\n')}

When a user wants to add a new task, you MUST have these three pieces of information before adding:
1. TIME - A specific time (e.g., "2pm", "around midday", "10:30 AM")
2. LOCATION - Either a specific address OR if they mention "Bunnings", use the Bunnings Carlingford location
3. PURPOSE/DESCRIPTION - What they need to do there

STRICT RULES - YOU MUST FOLLOW THESE:
- If they say "Bunnings" without a specific address, use "Bunnings Carlingford" at the known location
- If any of the 3 required pieces are missing, ask for them specifically
- Don't add a task until you have all 3 pieces of information
- Estimate duration if not provided (30-60 minutes for shopping, etc.)
- CRITICAL: Always use the EXACT SAME DATE as the items in the existing schedule - never use today's date
- Make sure the time does not conflict with existing tasks
- If there's a conflict, suggest the next available time slot

MANDATORY CONSTRAINTS FOR TASK CREATION:
- The "type" field can ONLY be one of these three values: "Task", "Quote inspection", or "Job on site"
- Determine the type based on context: "Task" for personal errands, "Quote inspection" for estimates/quotes, "Job on site" for actual work
- The start and end date fields must use the EXACT SAME DATE as the existing schedule items - NEVER use today's date
- You must include the "type" field in your ADD_TASK response

CRITICAL: When you have TIME, LOCATION, and PURPOSE, immediately respond with:
ADD_TASK: {"title": "task title", "location": "exact location", "startTime": "HH:MM AM/PM", "duration": "XX minutes", "description": "task description", "type": "Task|Quote inspection|Job on site"}

Then add a confirmation message. Example:
ADD_TASK: {"title": "Grocery shopping", "location": "Safeway on Oak Street", "startTime": "12:30 PM", "duration": "45 minutes", "description": "Pick up weekly groceries"}

Perfect! I've added grocery shopping to your schedule at 12:30 PM. This fits well between your morning appointments.`;

    // Build conversation messages - convert chat format to OpenAI format
    const convertedHistory = conversationHistory.map(msg => ({
      role: msg.author?.id === 'trav-chat-service' ? 'assistant' : 'user',
      content: msg.text
    }));

    const messages = [
      { role: 'system', content: systemPrompt },
      ...convertedHistory,
      { role: 'user', content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      max_tokens: 300,
      temperature: 0.7
    });

    const assistantMessage = completion.choices[0].message.content;

    // Debug logging
    console.log('OpenAI Response:', assistantMessage);

    // Check if the assistant wants to add a task
    let taskAdded = false;
    let addedTask = null;
    let updatedSchedule = [...schedule];

    if (assistantMessage.includes('ADD_TASK:')) {
      try {
        const addTaskMatch = assistantMessage.match(/ADD_TASK:\s*({.*?})/s);
        console.log('ADD_TASK match:', addTaskMatch);

        if (addTaskMatch) {
          const taskData = JSON.parse(addTaskMatch[1]);
          console.log('Parsed task data:', taskData);

          // Parse duration
          const durationMinutes = parseInt(taskData.duration) || 60;

          // Parse start time - handle different formats
          // Use the same date as existing schedule items
          let scheduleDate = new Date();
          if (schedule.length > 0) {
            scheduleDate = new Date(schedule[0].startDate);
          }

          let hour24, minute = 0;

          if (taskData.startTime.toLowerCase().includes('midday') || taskData.startTime.toLowerCase().includes('noon')) {
            hour24 = 12;
          } else {
            const timeMatch = taskData.startTime.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
            if (timeMatch) {
              hour24 = parseInt(timeMatch[1]);
              minute = parseInt(timeMatch[2]) || 0;
              const period = timeMatch[3]?.toLowerCase();

              if (period === 'pm' && hour24 !== 12) hour24 += 12;
              if (period === 'am' && hour24 === 12) hour24 = 0;
            } else {
              hour24 = 12; // Default to noon if can't parse
            }
          }

          const startDate = new Date(scheduleDate.getFullYear(), scheduleDate.getMonth(), scheduleDate.getDate(), hour24, minute);
          const endDate = new Date(startDate.getTime() + durationMinutes * 60000);

          // Determine location - use Bunnings data if mentioned
          let locationData;
          if (taskData.location.toLowerCase().includes('bunnings')) {
            locationData = bunningsLocation.location;
          } else {
            locationData = {
              formattedAddress: taskData.location,
              streetAddress: taskData.location,
              suburb: '',
              state: '',
              postcode: '',
              googlePlaceId: null,
              latitude: null,
              longitude: null,
            };
          }

          // Create new task in the expected schema format
          const newTask = {
            id: Math.max(...schedule.map(t => t.id || 0), 0) + 1,
            title: taskData.title,
            jobTitle: taskData.title,
            type: taskData.type || 'Task',
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            location: locationData,
            duration: {
              days: 0,
              hours: Math.floor(durationMinutes / 60),
              minutes: durationMinutes % 60
            },
            jobDescription: taskData.description,
          };

          console.log('Created new task:', newTask);

          updatedSchedule.push(newTask);

          // Sort schedule by start time
          updatedSchedule.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

          taskAdded = true;
          addedTask = newTask;
        }
      } catch (error) {
        console.error('Error parsing ADD_TASK:', error);
      }
    }

    // Clean up the response message (remove ADD_TASK JSON)
    const cleanResponse = assistantMessage.replace(/ADD_TASK:\s*{.*?}\s*/, '').trim();

    res.json({
      response: cleanResponse,
      schedule: updatedSchedule,
      taskAdded,
      addedTask,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to process chat message',
      details: error.message
    });
  }
});

// Get current schedule (now requires schedule to be passed as query param or body)
app.get('/schedule', (req, res) => {
  res.json({
    message: 'Schedule endpoint - pass schedule data in POST /chat requests',
    timestamp: new Date().toISOString()
  });
});

// Add task to schedule (deprecated - use POST /chat instead)
app.post('/schedule/add', (req, res) => {
  res.status(400).json({
    error: 'This endpoint is deprecated. Use POST /chat with schedule data instead.',
    timestamp: new Date().toISOString()
  });
});

// Helper function to round time to nearest quarter hour
function roundToQuarterHour(date) {
  const minutes = date.getMinutes();
  const roundedMinutes = Math.ceil(minutes / 15) * 15;
  const newDate = new Date(date);
  newDate.setMinutes(roundedMinutes);
  newDate.setSeconds(0);
  newDate.setMilliseconds(0);

  if (roundedMinutes === 60) {
    newDate.setMinutes(0);
    newDate.setHours(newDate.getHours() + 1);
  }

  return newDate;
}

// Helper function to parse date without timezone conversion
function parseDate(dateString) {
  if (!dateString) return null;
  // Handle ISO strings by extracting just the date part or parsing carefully
  if (dateString.includes('T')) {
    const datePart = dateString.split('T')[0];
    const [year, month, day] = datePart.split('-').map(Number);
    return new Date(year, month - 1, day); // month is 0-indexed
  }
  // Handle YYYY-MM-DD format
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day); // month is 0-indexed
}

// Helper function to add days to a date string without timezone issues
function addDaysToDateString(dateString, daysToAdd) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day + daysToAdd);

  const newYear = date.getFullYear();
  const newMonth = String(date.getMonth() + 1).padStart(2, '0');
  const newDay = String(date.getDate()).padStart(2, '0');

  return `${newYear}-${newMonth}-${newDay}`;
}

// Helper function to schedule jobs with optimized timing
function scheduleOptimizedJobs(optimizedJobs, distanceMatrix, destinations, routingDate) {
  const scheduledJobs = [...optimizedJobs];

  // Use provided routing date or get base date from first job or use today
  let baseDate = new Date();
  if (routingDate) {
    // Parse the yyyy-mm-dd format without timezone conversion
    baseDate = parseDate(routingDate);
    console.log(`Using provided routing date: ${routingDate} -> ${baseDate.toDateString()}`);
  } else if (optimizedJobs.length > 0 && optimizedJobs[0].startDate) {
    // Parse the existing date without timezone conversion
    baseDate = parseDate(optimizedJobs[0].startDate);
    console.log(`Using date from first job: ${optimizedJobs[0].startDate} -> ${baseDate.toDateString()}`);
  } else {
    console.log(`Using today's date: ${baseDate.toDateString()}`);
  }

  // Set start time between 7-9am (randomly pick 7:30am for consistency)
  let currentTime = new Date(baseDate);
  currentTime.setHours(7, 30, 0, 0);

  console.log(`Starting schedule at: ${currentTime.toLocaleString()}`);

  for (let i = 0; i < scheduledJobs.length; i++) {
    const job = scheduledJobs[i];

    // Get job duration in minutes
    const jobDurationMinutes = (job.duration.hours || 0) * 60 + (job.duration.minutes || 0);
    if (jobDurationMinutes === 0) {
      // Default to 60 minutes if no duration specified
      job.duration = { days: 0, hours: 1, minutes: 0 };
    }

    // Round start time to quarter hour
    const startTime = roundToQuarterHour(currentTime);
    const endTime = new Date(startTime.getTime() + ((job.duration.hours || 0) * 60 + (job.duration.minutes || 0)) * 60000);

    // Update job times using timezone-agnostic ISO format
    // Create ISO string in local time to avoid timezone shifts
    const formatDateLocal = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.000Z`;
    };

    job.startDate = formatDateLocal(startTime);
    job.endDate = formatDateLocal(endTime);

    console.log(`Scheduled ${job.title}: ${startTime.toLocaleTimeString()} - ${endTime.toLocaleTimeString()}`);

    // Calculate travel time to next job
    if (i < scheduledJobs.length - 1) {
      // Find travel time in distance matrix
      const currentJobIndex = destinations.findIndex(d => d.jobId === job.id);
      const nextJob = scheduledJobs[i + 1];
      const nextJobIndex = destinations.findIndex(d => d.jobId === nextJob.id);

      let travelMinutes = 15; // Default buffer

      if (currentJobIndex !== -1 && nextJobIndex !== -1) {
        // Add 1 to account for start location in matrix
        const matrixRowIndex = currentJobIndex + 1;
        const matrixElement = distanceMatrix.rows[matrixRowIndex]?.elements[nextJobIndex];

        if (matrixElement && matrixElement.duration) {
          travelMinutes = Math.ceil(matrixElement.duration.value / 60); // Convert seconds to minutes
          job.travelTimeToNext = matrixElement.duration.text;
          console.log(`Travel from ${job.title} to ${nextJob.title}: ${matrixElement.duration.text} (${travelMinutes} min)`);
        }
      }

      // Add buffer time (15-30 minutes)
      const bufferMinutes = Math.floor(Math.random() * 16) + 15; // Random between 15-30
      const totalTravelMinutes = travelMinutes + bufferMinutes;

      console.log(`Total travel + buffer: ${totalTravelMinutes} minutes (${travelMinutes} travel + ${bufferMinutes} buffer)`);

      // Set next job start time
      currentTime = new Date(endTime.getTime() + totalTravelMinutes * 60000);
    }
  }

  return scheduledJobs;
}

// Route optimization endpoint
app.post('/optimize-route', async (req, res) => {
  try {
    const { jobs, startLocation, routingDate } = req.body;

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({
        error: 'Jobs array is required and must contain at least one job'
      });
    }

    // Validate routing date format if provided
    if (routingDate && !routingDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return res.status(400).json({
        error: 'routingDate must be in YYYY-MM-DD format'
      });
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({
        error: 'Google Maps API key is not configured'
      });
    }

    // Extract locations from jobs
    const destinations = jobs.map(job => {
      if (!job.location || !job.location.latitude || !job.location.longitude) {
        throw new Error(`Job "${job.title}" is missing location coordinates`);
      }
      return {
        lat: job.location.latitude,
        lng: job.location.longitude,
        jobId: job.id,
        title: job.title,
        address: job.location.formattedAddress
      };
    });

    // Use start location if provided, otherwise use first job location
    const origin = startLocation || {
      lat: destinations[0].lat,
      lng: destinations[0].lng
    };

    // Get distance matrix to calculate travel times between all points
    const distanceMatrixResponse = await googleMapsClient.distancematrix({
      params: {
        origins: [origin, ...destinations.map(d => ({ lat: d.lat, lng: d.lng }))],
        destinations: destinations.map(d => ({ lat: d.lat, lng: d.lng })),
        mode: 'driving',
        units: 'metric',
        departure_time: 'now',
        traffic_model: 'best_guess',
        key: process.env.GOOGLE_MAPS_API_KEY,
      }
    });

    const matrix = distanceMatrixResponse.data;

    // Create AI prompt for route optimization
    const locationsInfo = destinations.map((dest, index) =>
      `${index + 1}. ${dest.title} at ${dest.address}`
    ).join('\n');

    const matrixInfo = matrix.rows.map((row, fromIndex) => {
      const fromLabel = fromIndex === 0 ? 'Start' : destinations[fromIndex - 1].title;
      return row.elements.map((element, toIndex) => {
        const toLabel = destinations[toIndex].title;
        const duration = element.duration ? element.duration.text : 'N/A';
        const distance = element.distance ? element.distance.text : 'N/A';
        return `${fromLabel} → ${toLabel}: ${duration} (${distance})`;
      }).join('\n');
    }).join('\n\n');

    const aiPrompt = `You are a route optimization expert. Given the following job locations and travel times, determine the most efficient route to visit all locations to minimize total travel time.

Jobs to visit:
${locationsInfo}

Travel times and distances:
${matrixInfo}

Please analyze the travel times and provide:
1. The optimal route order (list of job numbers)
2. Total estimated travel time
3. Brief explanation of why this route is optimal

Respond in JSON format:
{
  "optimizedRoute": [job numbers in optimal order],
  "totalTravelTime": "estimated total travel time",
  "explanation": "brief explanation of optimization strategy"
}`;

    // Get AI recommendation
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a route optimization expert. Always respond with valid JSON.' },
        { role: 'user', content: aiPrompt }
      ],
      max_tokens: 500,
      temperature: 0.3
    });

    let aiRecommendation;
    try {
      aiRecommendation = JSON.parse(completion.choices[0].message.content);
    } catch (parseError) {
      console.error('Failed to parse AI response:', completion.choices[0].message.content);
      throw new Error('Invalid AI response format');
    }

    // Create detailed route with job information
    const optimizedJobsRoute = aiRecommendation.optimizedRoute.map(jobIndex => {
      const job = jobs.find(j => j.id === destinations[jobIndex - 1].jobId);
      return {
        ...job,
        routeOrder: aiRecommendation.optimizedRoute.indexOf(jobIndex) + 1
      };
    });

    console.log('=== ROUTE OPTIMIZATION DEBUG ===');
    console.log('Original jobs count:', jobs.length);
    console.log('AI recommended route:', aiRecommendation.optimizedRoute);
    console.log('Optimized jobs route:', optimizedJobsRoute.map(j => ({ id: j.id, title: j.title, routeOrder: j.routeOrder })));

    // Schedule jobs with updated start/end times
    const scheduledJobs = scheduleOptimizedJobs(optimizedJobsRoute, matrix, destinations, routingDate);

    console.log('=== SCHEDULING DEBUG ===');
    scheduledJobs.forEach(job => {
      console.log(`Job ${job.routeOrder}: ${job.title}`);
      console.log(`  Start: ${new Date(job.startDate).toLocaleString()}`);
      console.log(`  End: ${new Date(job.endDate).toLocaleString()}`);
      console.log(`  Duration: ${job.duration.hours}h ${job.duration.minutes}m`);
      if (job.travelTimeToNext) {
        console.log(`  Travel to next: ${job.travelTimeToNext}`);
      }
      console.log('');
    });

    res.json({
      originalJobs: jobs,
      optimizedRoute: scheduledJobs,
      routeOptimization: aiRecommendation,
      distanceMatrix: matrix,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Route optimization error:', error);
    res.status(500).json({
      error: 'Failed to optimize route',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to calculate distance between two points using Haversine formula
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Helper function to distribute jobs across multiple days using heuristics
function distributeJobsAcrossDays(jobs, maxJobsPerDay = 7) {
  if (jobs.length <= maxJobsPerDay) {
    return [jobs]; // All jobs fit in one day
  }

  // Extract locations for clustering analysis
  const jobsWithDistance = jobs.map(job => ({
    ...job,
    lat: job.location.latitude,
    lng: job.location.longitude,
    totalDuration: (job.duration.hours || 0) * 60 + (job.duration.minutes || 0)
  }));

  // Sort by priority: urgent jobs first, then by job type, then by duration
  const prioritizedJobs = jobsWithDistance.sort((a, b) => {
    // Priority 1: Job type priority (Job on site > Quote inspection > Task)
    const typePriority = { 'Job on site': 3, 'Quote inspection': 2, 'Task': 1 };
    const aPriority = typePriority[a.type] || 1;
    const bPriority = typePriority[b.type] || 1;

    if (aPriority !== bPriority) return bPriority - aPriority;

    // Priority 2: Longer duration jobs first (easier to balance)
    return b.totalDuration - a.totalDuration;
  });

  const days = [];
  let currentDay = [];
  let currentDayDuration = 0;
  const maxDayDuration = 8 * 60; // 8 hours max per day

  // Distribute jobs using a greedy approach with geographic clustering
  for (const job of prioritizedJobs) {
    const jobDuration = job.totalDuration || 60; // Default 1 hour

    // Check if job fits in current day
    if (currentDay.length < maxJobsPerDay &&
        currentDayDuration + jobDuration <= maxDayDuration) {

      // If current day is empty, add job
      if (currentDay.length === 0) {
        currentDay.push(job);
        currentDayDuration += jobDuration;
        continue;
      }

      // Calculate average distance to jobs in current day
      const avgDistanceToCurrentDay = currentDay.reduce((sum, dayJob) =>
        sum + calculateDistance(job.lat, job.lng, dayJob.lat, dayJob.lng), 0
      ) / currentDay.length;

      // If job is reasonably close to current day's jobs (within 15km average), add it
      if (avgDistanceToCurrentDay <= 15) {
        currentDay.push(job);
        currentDayDuration += jobDuration;
        continue;
      }
    }

    // Start a new day
    if (currentDay.length > 0) {
      days.push(currentDay);
    }
    currentDay = [job];
    currentDayDuration = jobDuration;
  }

  // Add the last day if it has jobs
  if (currentDay.length > 0) {
    days.push(currentDay);
  }

  // Post-processing: Balance days by moving jobs if beneficial
  for (let i = 0; i < days.length - 1; i++) {
    const currentDayJobs = days[i];
    const nextDayJobs = days[i + 1];

    // If current day is overloaded and next day has capacity
    if (currentDayJobs.length > maxJobsPerDay * 0.8 &&
        nextDayJobs.length < maxJobsPerDay * 0.6) {

      // Find the best job to move (furthest from current day's cluster)
      let jobToMove = null;
      let maxDistance = 0;

      for (const job of currentDayJobs) {
        const avgDistance = currentDayJobs
          .filter(j => j.id !== job.id)
          .reduce((sum, j) => sum + calculateDistance(job.lat, job.lng, j.lat, j.lng), 0) /
          (currentDayJobs.length - 1);

        if (avgDistance > maxDistance) {
          maxDistance = avgDistance;
          jobToMove = job;
        }
      }

      // Move the job if it's significantly far from the cluster
      if (jobToMove && maxDistance > 10) {
        days[i] = currentDayJobs.filter(j => j.id !== jobToMove.id);
        days[i + 1].unshift(jobToMove);
      }
    }
  }

  return days;
}

// Multi-day route optimization endpoint
app.post('/optimize-multi-day-route', async (req, res) => {
  try {
    const { jobs, startLocation, startFromDate } = req.body;

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({
        error: 'Jobs array is required and must contain at least one job'
      });
    }

    if (jobs.length > 20) {
      return res.status(400).json({
        error: 'Maximum 20 jobs supported for multi-day optimization'
      });
    }

    if (!startFromDate || !startFromDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return res.status(400).json({
        error: 'startFromDate is required and must be in YYYY-MM-DD format'
      });
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({
        error: 'Google Maps API key is not configured'
      });
    }

    console.log(`=== MULTI-DAY OPTIMIZATION START ===`);
    console.log(`Total jobs: ${jobs.length}`);
    console.log(`Start date: ${startFromDate}`);

    // Step 1: Distribute jobs across days
    const jobsByDay = distributeJobsAcrossDays(jobs, 7); // Max 7 jobs per day

    console.log(`Jobs distributed across ${jobsByDay.length} days:`);
    jobsByDay.forEach((dayJobs, index) => {
      console.log(`Day ${index + 1}: ${dayJobs.length} jobs - ${dayJobs.map(j => j.title).join(', ')}`);
    });

    // Step 2: Optimize route for each day
    const optimizedDays = [];

    for (let dayIndex = 0; dayIndex < jobsByDay.length; dayIndex++) {
      const dayJobs = jobsByDay[dayIndex];
      const routingDate = addDaysToDateString(startFromDate, dayIndex);

      console.log(`\n--- Optimizing Day ${dayIndex + 1} (${routingDate}) ---`);

      // Reuse the existing single-day optimization logic
      const destinations = dayJobs.map(job => {
        if (!job.location || !job.location.latitude || !job.location.longitude) {
          throw new Error(`Job "${job.title}" is missing location coordinates`);
        }
        return {
          lat: job.location.latitude,
          lng: job.location.longitude,
          jobId: job.id,
          title: job.title,
          address: job.location.formattedAddress
        };
      });

      const origin = startLocation || {
        lat: destinations[0].lat,
        lng: destinations[0].lng
      };

      // Get distance matrix for this day's jobs
      const distanceMatrixResponse = await googleMapsClient.distancematrix({
        params: {
          origins: [origin, ...destinations.map(d => ({ lat: d.lat, lng: d.lng }))],
          destinations: destinations.map(d => ({ lat: d.lat, lng: d.lng })),
          mode: 'driving',
          units: 'metric',
          departure_time: 'now',
          traffic_model: 'best_guess',
          key: process.env.GOOGLE_MAPS_API_KEY,
        }
      });

      const matrix = distanceMatrixResponse.data;

      // Create AI prompt for this day's route optimization
      const locationsInfo = destinations.map((dest, index) =>
        `${index + 1}. ${dest.title} at ${dest.address}`
      ).join('\n');

      const matrixInfo = matrix.rows.map((row, fromIndex) => {
        const fromLabel = fromIndex === 0 ? 'Start' : destinations[fromIndex - 1].title;
        return row.elements.map((element, toIndex) => {
          const toLabel = destinations[toIndex].title;
          const duration = element.duration ? element.duration.text : 'N/A';
          const distance = element.distance ? element.distance.text : 'N/A';
          return `${fromLabel} → ${toLabel}: ${duration} (${distance})`;
        }).join('\n');
      }).join('\n\n');

      const aiPrompt = `You are a route optimization expert. Given the following job locations and travel times for Day ${dayIndex + 1}, determine the most efficient route to visit all locations to minimize total travel time.

Jobs to visit on Day ${dayIndex + 1}:
${locationsInfo}

Travel times and distances:
${matrixInfo}

Please analyze the travel times and provide:
1. The optimal route order (list of job numbers)
2. Total estimated travel time
3. Brief explanation of why this route is optimal

Respond in JSON format:
{
  "optimizedRoute": [job numbers in optimal order],
  "totalTravelTime": "estimated total travel time",
  "explanation": "brief explanation of optimization strategy"
}`;

      // Get AI recommendation for this day
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a route optimization expert. Always respond with valid JSON.' },
          { role: 'user', content: aiPrompt }
        ],
        max_tokens: 500,
        temperature: 0.3
      });

      let aiRecommendation;
      try {
        aiRecommendation = JSON.parse(completion.choices[0].message.content);
      } catch (parseError) {
        console.error('Failed to parse AI response:', completion.choices[0].message.content);
        throw new Error(`Invalid AI response format for Day ${dayIndex + 1}`);
      }

      // Create detailed route with job information
      const optimizedJobsRoute = aiRecommendation.optimizedRoute.map(jobIndex => {
        const job = dayJobs.find(j => j.id === destinations[jobIndex - 1].jobId);
        return {
          ...job,
          routeOrder: aiRecommendation.optimizedRoute.indexOf(jobIndex) + 1
        };
      });

      // Schedule jobs with updated start/end times
      const scheduledJobs = scheduleOptimizedJobs(optimizedJobsRoute, matrix, destinations, routingDate);

      optimizedDays.push({
        date: routingDate,
        dayNumber: dayIndex + 1,
        jobs: scheduledJobs,
        routeOptimization: aiRecommendation,
        totalJobs: scheduledJobs.length,
        estimatedStartTime: scheduledJobs[0]?.startDate,
        estimatedEndTime: scheduledJobs[scheduledJobs.length - 1]?.endDate
      });

      console.log(`Day ${dayIndex + 1} optimized: ${scheduledJobs.length} jobs, route: ${aiRecommendation.optimizedRoute.join(' → ')}`);
    }

    // Calculate summary statistics
    const totalJobs = optimizedDays.reduce((sum, day) => sum + day.totalJobs, 0);
    const totalDays = optimizedDays.length;

    console.log(`\n=== MULTI-DAY OPTIMIZATION COMPLETE ===`);
    console.log(`Total jobs scheduled: ${totalJobs} across ${totalDays} days`);

    res.json({
      originalJobs: jobs,
      optimizedSchedule: optimizedDays,
      summary: {
        totalJobs,
        totalDays,
        startDate: startFromDate,
        endDate: optimizedDays[optimizedDays.length - 1]?.date,
        averageJobsPerDay: Math.round(totalJobs / totalDays * 10) / 10
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Multi-day route optimization error:', error);
    res.status(500).json({
      error: 'Failed to optimize multi-day route',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Chat endpoint: http://localhost:${PORT}/chat`);
  console.log(`Schedule endpoint: http://localhost:${PORT}/schedule`);
  console.log(`Route optimization endpoint: http://localhost:${PORT}/optimize-route`);
  console.log(`Multi-day route optimization endpoint: http://localhost:${PORT}/optimize-multi-day-route`);
});