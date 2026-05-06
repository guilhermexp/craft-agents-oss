import { describe, expect, it } from 'bun:test'
import { classifyFile } from '../file-classification'

describe('classifyFile', () => {
  it('routes audio files to the in-app audio preview', () => {
    expect(classifyFile('/tmp/output.mp3')).toEqual({ type: 'audio', canPreview: true })
    expect(classifyFile('/tmp/output.wav')).toEqual({ type: 'audio', canPreview: true })
    expect(classifyFile('/tmp/output.m4a')).toEqual({ type: 'audio', canPreview: true })
  })

  it('keeps video files external until a video overlay exists', () => {
    expect(classifyFile('/tmp/output.mp4')).toEqual({ type: null, canPreview: false })
    expect(classifyFile('/tmp/output.mov')).toEqual({ type: null, canPreview: false })
  })
})
