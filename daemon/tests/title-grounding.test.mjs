import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groundedTitle } from '../lib/title-grounding.mjs'
const item = { source: 'notifications', thread: 'Discord', sender: 'Nika (#sample, Text)', text: 'Nika (#sample, Text): @Me the archive page is missing' }
test('sender and app metadata cannot become the task location', () => {
  assert.equal(groundedTitle('Add the archive page in Nika',item),'Add the archive page')
  assert.equal(groundedTitle('Add the archive page in Discord.',item),'Add the archive page.')
})
test('explicitly named platforms and people in message content remain', () => {
  assert.equal(groundedTitle('Fix notifications in Discord',{...item,text:'Please fix notifications in Discord'}),'Fix notifications in Discord')
  assert.equal(groundedTitle('Fix notifications in Discord',item,[{text:'The Discord integration is broken'}]),'Fix notifications in Discord')
  assert.equal(groundedTitle('Send the archive page to Nika',item),'Send the archive page to Nika')
})
test('a normal product name is unaffected', () => {
  assert.equal(groundedTitle('Add the archive page in Example',item),'Add the archive page in Example')
})
