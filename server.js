const express = require('express');
const OpenAI = require('openai');
const { bunningsLocation } = require('./data.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Chat endpoint: http://localhost:${PORT}/chat`);
  console.log(`Schedule endpoint: http://localhost:${PORT}/schedule`);
});