import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GeminiControl from './GeminiControl.tsx'

afterEach(() => vi.unstubAllGlobals())

describe('GeminiControl', () => {
  it('shows startup-off status and explicitly enables the server gate', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ enabled: false, apiKeyConfigured: true }),
      )
      .mockResolvedValueOnce(
        Response.json({ enabled: true, apiKeyConfigured: true }),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<GeminiControl onEnabledChange={vi.fn()} />)

    const toggle = await screen.findByRole('switch', {
      name: /llamadas a gemini/i,
    })
    expect(toggle).toHaveClass('app__ai-toggle-switch')
    expect(toggle.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/clave configurada/i)).toBeInTheDocument()
    await userEvent.setup().click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/gemini/status'),
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('apiKey')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
