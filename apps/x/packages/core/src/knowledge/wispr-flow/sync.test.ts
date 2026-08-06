import { describe, expect, it } from 'vitest';
import { chooseWisprTools, meetingToMarkdown, normalizeWisprMeeting } from './sync.js';

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

  it('writes Rowboat meeting frontmatter and knowledge sections', () => {
    const markdown = meetingToMarkdown({
      id: 'meeting-1',
      title: 'Product review',
      occurredAt: '2026-08-06T10:00:00.000Z',
      participants: ['Rahul'],
      thoughts: 'Personal note',
      summary: 'Summary text',
      transcript: '**Rahul:** Hello',
      finalized: true,
    });
    expect(markdown).toContain('source: wispr-flow');
    expect(markdown).toContain('## My thoughts');
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('```transcript');
  });
});
