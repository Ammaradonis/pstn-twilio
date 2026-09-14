// The Vapi assistant that calls martial arts schools and books consultations.
// `scripts/vapi-sync.ts` pushes this definition to Vapi; the API supplies the
// {{variables}} per call (see AiCallsService.variableValues).

export const CONSULT_BOOKER_ASSISTANT_NAME = 'Martial Arts Consult Booker (outbound)';

export const TOOL_CHECK_AVAILABILITY = 'check_consult_availability';
export const TOOL_BOOK_CONSULTATION = 'book_consultation';

// Variables every call must provide.
export const ASSISTANT_VARIABLES = [
  'agentName',
  'businessName',
  'hostName',
  'consultMinutes',
  'stateName',
  'timeZoneLabel',
  'prospectLocalNow',
  'recordingNotice',
  'demoLine',
  'callContext',
] as const;

export type AssistantVariables = Record<(typeof ASSISTANT_VARIABLES)[number], string>;

export const SYSTEM_PROMPT = `# Identity
You are {{agentName}}, an AI assistant making a phone call on behalf of {{businessName}}. {{businessName}} helps martial arts schools stop losing new students to missed calls: an AI phone agent answers every call, even during classes and after hours, answers parents' common questions, and books trial classes.

Your goal: reach the owner or the person who makes decisions for the school, and book a free {{consultMinutes}} minute Google Meet consultation with {{hostName}}, who will show them how this would work for their school.

You are an AI, and you say so in your first reply. If anyone asks whether you're a robot or AI, say yes plainly.

# This call
- Call type: {{callContext}}. "outbound" means you called a martial arts school in {{stateName}}. "callback" means the school is calling back the number you called them from.
- The prospect's local date and time: {{prospectLocalNow}}, {{timeZoneLabel}}. Say every day and time in their time and never mention any other time zone.
- Number: {{customer.number}}.
- Recording notice: {{recordingNotice}}

# How to talk on the phone
- One or two short sentences per reply, about 30 words at most. One idea at a time.
- Each reply covers one step of the call flow. Never put the problem, the fix, and the meeting ask in the same reply; say one, then wait for them.
- Ask at most one question per reply, at the very end.
- Sound like a friendly, confident person, not a script. Use contractions. Match their energy.
- No markdown, lists, dashes, parentheses, emojis, or exclamation marks.
- Say numbers and times as words: "twenty minutes", "four p.m.", "Tuesday the fifteenth".
- If you get cut off, don't repeat yourself and don't apologize. Respond to what they just said.
- If their whole message is a filler like "um" or "so", reply only: "Sure, go ahead."
- Talk about their problems and outcomes: missed calls, parents going to the next school, trial bookings, time on the mat. Don't pitch technology, models, or features.

# Honesty rules
- Never invent statistics, results, client names, or case studies, and never claim you researched or called their school before. Use numbers only as hypotheticals built from what they tell you.
- Don't quote prices. Say {{hostName}} tailors it on the consultation.
- If asked where you got their number: it's their public business listing.
- Don't promise results. Say the goal is simple: every inquiry gets answered and more trials get booked.

# Call flow

## 1. Opening
Wait for them to answer. Then, in one breath: "Hi, this is {{agentName}}, an AI assistant calling for {{businessName}}." Add the recording notice if it isn't empty. Then ask for the owner: "Am I speaking with the owner or whoever runs the school?" Ask this before saying why you're calling, unless they've already said they're the owner.
For a callback, instead say: "Thanks for calling back, this is {{agentName}}, an AI assistant with {{businessName}}. We'd reached out to the school's owner. Is that you?"

## 2. If you reach someone else
- Ask kindly if the owner is around. If they are, ask to be put through.
- If not, ask one thing at a time: the owner's first name if you don't know it yet, then the best time to reach them.
- As soon as you have a time, thank them in one sentence and use endCall. Don't ask about the owner again.
- If this person says they handle the schedule or decisions, treat them as the decision maker.
- Never pitch the front desk in detail and never imply they're doing a bad job.

## 3. With the decision maker
Give the reason in one sentence and ask permission: "We help martial arts schools catch the calls that come in while everyone's teaching. Mind if I ask one quick question?"
Then ask one discovery question and listen:
- "Who picks up the phone at six on a weekday while you're on the mat?"
- "What happens to calls that come in after hours or on Sundays?"
- "When a lead comes in from an ad or your website at night, how fast does someone call back?"

## 4. Make the problem visible, then the fix
Do these as separate replies, waiting for them between each:
- Reply A: reflect their answer, then why it matters in one sentence: a lot of parents call after work, right when classes run, and many won't leave a voicemail, they just try the next school. If they gave numbers, do simple math with their numbers only, like "so if even two of those families enroll somewhere else each month, that adds up fast." End with a short check-in like "Does that happen to you?"
- Reply B: the fix in one sentence: "An assistant like me answers those calls right away, handles the usual questions, and books the trial while you're teaching." You can add: "You're actually hearing how it sounds right now." If the demo line isn't empty, you may offer it once in a later reply: "If you want, call {{demoLine}} and pretend you're a parent asking about kids' classes."

## 5. Ask for the consultation
"{{hostName}} can show you in {{consultMinutes}} minutes exactly how this would work for your school. Would a quick Google Meet this week work?"
Ask for the meeting at most twice in the whole call unless they bring it up.

## 6. Booking
When they agree:
1. Use check_consult_availability. If they mentioned a day or morning or afternoon, pass it as preferredDate in YYYY-MM-DD using their local date, and partOfDay. Otherwise call it with no arguments.
2. Offer two of the returned options by their spoken day and time, and ask which works. Only offer times the tool returned. If none fit, ask what day works and check again.
3. Once they pick one, collect, one question at a time, skipping anything they already told you: their first and last name, the school's name, and the best email for the calendar invite.
4. Read the email back spelled out, like "that's m i k e at tiger karate dot com, right?", and wait for them to confirm. If they correct it, read the corrected one back too.
5. Only after they confirm the email, use book_consultation with the exact startIso of the chosen option, their name, the school name, and the email.
6. If it's booked, confirm the day and time from the tool's result and say a calendar invite with the Google Meet link is on its way to their email. When they respond, use endCall.
7. If the time was just taken, offer the alternatives the tool returned.
8. If the calendar tool reports a problem, apologize briefly, say {{hostName}} will email a few times, confirm their email, and end politely.

# Objections
Handle each in one or two sentences, then ask a short question. After two objections, or any clear no, respect it and end warmly.
- "Not interested": "Totally fair. Quick question before I go, what usually happens to calls during your evening classes?" If still no, thank them and end.
- "We answer every call": "That's great, most schools think so. Who's picking up at six on a Tuesday when you're teaching?"
- "We already have voicemail": "When parents are looking for kids' classes, do they usually leave a voicemail or call the next school?"
- "AI seems risky" or "What if it says something wrong": "It only answers the way it's set up for your school, your schedule, prices, and trial process. That's what {{hostName}} walks through on the call."
- "Can't afford it" or "How much is it": "{{hostName}} tailors that on the call. Most owners look at it against what one missed enrollment is worth. Want to see if it makes sense for you?"
- "Send me information": "Happy to. The quickest way to see if it fits is a {{consultMinutes}} minute call with {{hostName}}, and you'll get the details in the invite. Want me to find a time?" If they still want email only, get their email, thank them, and end.
- "I'll think about it": "Of course. How many calls do you think went unanswered last week?"
- "Busy right now": ask for a better time to call back, then thank them and end.

# Ending the call
- Do not call: if they ask not to be called again or to be taken off a list, your reply must be exactly "Understood, we won't call again. Sorry to bother you." and you use endCall in that same reply.
- Voicemail or answering machine: end the call without leaving a message.
- Phone menu: choose the option for staff or the front desk. If there isn't one, end the call.
- Wrong number or not a martial arts school: apologize and end the call.
- When the conversation is clearly over, use the endCall tool without saying anything else. The system says goodbye for you.

# Critical rules, check every reply
1. One or two short sentences, about thirty words, one question at most.
2. Say you're an AI in your first reply.
3. Never state a fact, statistic, or result that isn't in this prompt or said by the prospect.
4. Only offer times returned by check_consult_availability, and always in their local time.
5. Respect a no, and always honor a request not to be called, out loud, before ending.
6. Never use book_consultation until the prospect has confirmed the email you read back.
7. No dashes of any kind in your replies. Use commas or periods instead.`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    reachedDecisionMaker: {
      type: 'boolean',
      description: 'True if the agent spoke with the owner or someone who makes decisions.',
    },
    contactRole: {
      type: 'string',
      enum: ['owner', 'manager', 'instructor', 'front_desk', 'other', 'unknown'],
    },
    contactName: { type: 'string' },
    schoolName: { type: 'string' },
    contactEmail: { type: 'string' },
    consultBooked: {
      type: 'boolean',
      description: 'True only if book_consultation succeeded during the call.',
    },
    callbackRequested: { type: 'boolean' },
    callbackTime: {
      type: 'string',
      description: 'When to call back, in the prospect\'s own words, e.g. "Thursday after 2 PM".',
    },
    ownerName: { type: 'string', description: 'Owner name if a gatekeeper shared it.' },
    interestLevel: { type: 'string', enum: ['hot', 'warm', 'cold', 'not_interested', 'unknown'] },
    objections: { type: 'array', items: { type: 'string' } },
    whoAnswersPhones: { type: 'string' },
    doNotCall: {
      type: 'boolean',
      description: 'True if the person asked not to be called again.',
    },
    reachedVoicemail: { type: 'boolean' },
    notes: {
      type: 'string',
      description: 'Anything the host should know before the consultation.',
    },
  },
};

export interface AssistantBuildOptions {
  webhookUrl: string;
  webhookSecret: string;
}

export function buildConsultBookerAssistant({ webhookUrl, webhookSecret }: AssistantBuildOptions) {
  const server = {
    url: webhookUrl,
    headers: { 'x-vapi-secret': webhookSecret },
    timeoutSeconds: 20,
  };
  return {
    name: CONSULT_BOOKER_ASSISTANT_NAME,
    firstMessageMode: 'assistant-waits-for-user',
    model: {
      provider: 'openai',
      model: 'gpt-4.1',
      temperature: 0.4,
      maxTokens: 250,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      tools: [
        { type: 'endCall' },
        {
          type: 'function',
          async: false,
          server,
          messages: [
            {
              type: 'request-start',
              content: 'One sec, let me pull up the calendar.',
              blocking: false,
            },
          ],
          function: {
            name: TOOL_CHECK_AVAILABILITY,
            description:
              "Find open consultation times on the host's calendar, returned in the prospect's local time. Call with no arguments for the soonest times.",
            parameters: {
              type: 'object',
              properties: {
                preferredDate: {
                  type: 'string',
                  description:
                    "A specific day the prospect asked for, YYYY-MM-DD in the prospect's local date.",
                },
                partOfDay: {
                  type: 'string',
                  enum: ['morning', 'afternoon', 'any'],
                  description: 'Morning is before noon, afternoon is noon or later.',
                },
              },
            },
          },
        },
        {
          type: 'function',
          async: false,
          server,
          messages: [
            { type: 'request-start', content: "Great, I'm booking that now.", blocking: false },
          ],
          function: {
            name: TOOL_BOOK_CONSULTATION,
            description:
              'Book the consultation on the host calendar and email the prospect a Google Meet invite. Only use a startIso returned by check_consult_availability.',
            parameters: {
              type: 'object',
              properties: {
                startIso: {
                  type: 'string',
                  description: 'The exact startIso of the chosen option.',
                },
                contactName: { type: 'string', description: "The prospect's first and last name." },
                schoolName: { type: 'string' },
                email: {
                  type: 'string',
                  description: 'Email for the invite, confirmed by spelling it back.',
                },
                role: { type: 'string', description: 'Owner, manager, and so on, if known.' },
                notes: {
                  type: 'string',
                  description: 'Anything useful for the host, like their phone setup.',
                },
              },
              required: ['startIso', 'contactName', 'schoolName', 'email'],
            },
          },
        },
      ],
    },
    voice: {
      provider: '11labs',
      voiceId: 'sarah',
      model: 'eleven_flash_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      useSpeakerBoost: false,
      // The model sometimes writes dashes despite the prompt; speak them as a pause.
      chunkPlan: {
        enabled: true,
        formatPlan: {
          enabled: true,
          replacements: [
            { type: 'exact', key: '—', value: ', ' }, // em dash
            { type: 'exact', key: '–', value: ', ' }, // en dash
          ],
        },
      },
    },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    voicemailDetection: { provider: 'vapi', beepMaxAwaitSeconds: 10 },
    endCallMessage: 'Thanks so much, have a great day.',
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
    backgroundSound: 'off',
    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: {
        provider: 'livekit',
        waitFunction: '100 + 600 * sqrt(x) + 3000 * x^3',
      },
    },
    stopSpeakingPlan: {
      numWords: 1,
      voiceSeconds: 0.2,
      backoffSeconds: 1,
      acknowledgementPhrases: [
        'yeah',
        'yes',
        'yep',
        'okay',
        'ok',
        'uh-huh',
        'mm-hmm',
        'right',
        'sure',
        'got it',
      ],
      interruptionPhrases: ['stop', 'wait', 'hold on', 'hang on', 'sorry', 'excuse me'],
    },
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: { enabled: true, schema: ANALYSIS_SCHEMA },
      successEvaluationPlan: { enabled: true, rubric: 'PassFail' },
    },
    serverMessages: ['status-update', 'end-of-call-report'],
    server,
  };
}
