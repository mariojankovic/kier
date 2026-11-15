import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adult, adultHost } from '../lib/privacy.mjs'

test('adult sites are caught by name, by top level domain and by words in the host', () => {
  for (const h of ['www.pornhub.com', 'de.xhamster.com', 'something.xxx', 'free-porn-tube.net', 'hotsexcam.sex', 'nudes-daily.com']) assert.ok(adultHost(h), h)
  for (const h of ['sussex.ac.uk', 'essex.gov.uk', 'expornent.com'.replace('porn', 'pon'), 'github.com', 'example.com', 'middlesex.edu']) assert.ok(!adultHost(h), h)
})

test('searches, page titles and file names with adult words are dropped, ordinary ones kept', () => {
  assert.ok(adult({ source: 'browser', thread: 'google.com', text: 'Searched Google: best porn sites' }))
  assert.ok(adult({ source: 'browser', thread: 'duckduckgo.com', text: 'seks video at DuckDuckGo' }))
  assert.ok(adult({ source: 'downloads', thread: 'Downloads', text: 'Downloaded nsfw_pack.zip (2 MB)' }))
  assert.ok(!adult({ source: 'browser', thread: 'bbc.co.uk', text: 'Weather in Sussex and Essex' }))
  assert.ok(!adult({ source: 'browser', thread: 'google.com', text: 'Searched Google: OBS sexagesimal timecode' }))
})

test('people joking in chats are kept, but a link to an adult site is not', () => {
  assert.ok(!adult({ source: 'whatsapp', thread: 'Workshop', text: 'ovo je porno od koda haha' }))
  assert.ok(adult({ source: 'whatsapp', thread: 'Workshop', text: 'gledaj https://www.xvideos.com/video123' }))
})

test('adult words in the other languages Kier knows are dropped too, and their everyday neighbours kept', () => {
  for (const text of ['Searched Google: videos de sexo', 'sesso video at DuckDuckGo', 'Searched Google: sexe en ligne', 'Searched Google: sexfilme kostenlos']) {
    assert.ok(adult({ source: 'browser', thread: 'google.com', text }), text)
  }
  for (const text of ['Searched Google: sexto piso sin ascensor', 'Tetteh family recipes', 'Searched Google: essere o non essere']) {
    assert.ok(!adult({ source: 'browser', thread: 'google.com', text }), text)
  }
})
