import { describe, expect, it } from 'vitest';
import {
  chooseWisprTools,
  detailArguments,
  listArguments,
  meetingToMarkdown,
  normalizeWisprMeeting,
} from './sync.js';

describe('Wispr Flow meeting sync', () => {
  it('normalizes finalized Notetaker artifacts and groups transcript turns', () => {
    const meeting = normalizeWisprMeeting({
      id: 'meeting-1',
      title: 'Product review',
      status: 'completed',
      startedAt: '2026-08-06T10:00:00Z',
      myThoughts: 'Remember the launch constraint.',
      summary: 'The team chose option B.',
      participants: [{ displayName: 'Rahul' }, { name: 'Akbar' }],
      transcript: {
        segments: [
          { speakerName: 'Rahul', text: 'First sentence.' },
          { speakerName: 'Rahul', text: 'Second sentence.' },
          { speakerName: 'Akbar', text: 'Reply.' },
        ],
      },
    });
    expect(meeting).not.toBeNull();
    expect(meeting?.finalized).toBe(true);
    expect(meeting?.participants).toEqual(['Rahul', 'Akbar']);
    expect(meeting?.transcript).toContain('**Rahul:** First sentence. Second sentence.');
  });

  it('normalizes Wispr MCP post-call fields without requiring a transcript', () => {
    const meeting = normalizeWisprMeeting({
      id: 'wispr-meeting-1',
      title: 'Zoom meeting',
      content: 'Remember the personal follow-up.',
      summary: 'Rahul and Akbar agreed on the launch.',
      finalized: true,
      has_transcript: false,
      attendees: [{ name: 'Rahul' }, { email: 'akbar@example.com' }],
      todos: [{ text: 'Send the launch brief' }],
      start: '2026-08-06T10:00:00Z',
      end: '2026-08-06T10:30:00Z',
      modified_at: '2026-08-06T10:31:00Z',
    });
    expect(meeting).toMatchObject({
      thoughts: 'Remember the personal follow-up.',
      participants: ['Rahul', 'akbar@example.com'],
      actionItems: ['Send the launch brief'],
      occurredAt: '2026-08-06T10:00:00.000Z',
      endedAt: '2026-08-06T10:30:00.000Z',
      finalized: true,
    });
    expect(meeting?.transcript).toBeUndefined();
  });

  it('does not import a transcript-only live meeting', () => {
    const meeting = normalizeWisprMeeting({
      id: 'meeting-live',
      status: 'recording',
      transcript: 'Still in progress',
    });
    expect(meeting?.finalized).toBe(false);
  });

  it('selects meeting search and detail tools without hard-coding Wispr names', () => {
    const selected = chooseWisprTools([
      { name: 'search_notetaker_meetings', description: 'Search meeting notes' },
      { name: 'get_notetaker_meeting', description: 'Get meeting transcript and brief' },
      { name: 'search_dictations', description: 'Search dictation history' },
    ]);
    expect(selected.list.name).toBe('search_notetaker_meetings');
    expect(selected.detail?.name).toBe('get_notetaker_meeting');
  });

  it('prefers Wispr meeting detail over similarly described calendar tools', () => {
    const selected = chooseWisprTools([
      { name: 'search_meetings', description: 'Search recorded meetings' },
      { name: 'get_upcoming_meeting', description: 'Get upcoming meeting by calendar id' },
      { name: 'get_meeting', description: 'Get recorded notes and transcript' },
    ]);
    expect(selected.list.name).toBe('search_meetings');
    expect(selected.detail?.name).toBe('get_meeting');
  });

  it('uses Wispr recent-meeting semantics and requests post-call artifacts', () => {
    const listTool = {
      name: 'search_meetings',
      inputSchema: { properties: { query: {}, since: {}, until: {}, limit: {} } },
    };
    const detailTool = {
      name: 'get_meeting',
      inputSchema: { properties: { meeting_id: {}, view_content: {}, view_transcript: {} } },
    };
    expect(listArguments(listTool)).toEqual({ limit: 50 });
    expect(detailArguments(detailTool, 'meeting-1')).toEqual({
      meeting_id: 'meeting-1',
      view_content: { start_char: 0, char_limit: 40_000 },
      view_transcript: { start_char: 0, char_limit: 40_000 },
    });
  });

  it('writes Rowboat meeting frontmatter and knowledge sections', () => {
    const markdown = meetingToMarkdown({
      id: 'meeting-1',
      title: 'Product review',
      occurredAt: '2026-08-06T10:00:00.000Z',
      participants: ['Rahul'],
      thoughts: 'Personal note',
      summary: 'Summary text',
      actionItems: ['Send brief'],
      transcript: '**Rahul:** Hello',
      finalized: true,
    });
    expect(markdown).toContain('source: wispr-flow');
    expect(markdown).toContain('## My thoughts');
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Action items');
    expect(markdown).toContain('```transcript');
  });
});
