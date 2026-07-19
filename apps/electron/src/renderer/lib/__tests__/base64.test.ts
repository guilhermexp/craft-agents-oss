import { describe, expect, it } from 'bun:test'
import { uint8ArrayToBase64 } from '../base64'

describe('uint8ArrayToBase64', () => {
  it('encodes payloads larger than a single safe call-stack chunk', () => {
    const bytes = new Uint8Array(100_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256

    expect(uint8ArrayToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})
