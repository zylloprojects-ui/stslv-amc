import { describe, expect, it } from 'vitest'
import { formatDate } from '../lib/format'
import { formatMoney, formatRate, isMoney, isRate, isZeroAmount, previewVat } from '../lib/money'

describe('money text handling', () => {
  it('formats stored amounts with thousands separators and three decimals, without converting to a number', () => {
    expect(formatMoney('1234.567')).toBe('1,234.567')
    expect(formatMoney('0.300')).toBe('0.300')
    expect(formatMoney('99999999999.999')).toBe('99,999,999,999.999')
    expect(formatMoney('1234567.5')).toBe('1,234,567.500')
    expect(formatMoney('-200.500')).toBe('−200.500')
    expect(formatMoney(null)).toBe('—')
  })

  it('accepts only amounts with at most three decimals', () => {
    for (const value of ['0', '10', '1234.567', '0.001', '99999999999.999']) {
      expect(isMoney(value), value).toBe(true)
    }
    for (const value of ['', '1.2345', '-1', '1e3', '1,000', 'abc', '100000000000', '.5', '5.']) {
      expect(isMoney(value), value).toBe(false)
    }
    expect(isZeroAmount('0.000')).toBe(true)
    expect(isZeroAmount('0.001')).toBe(false)
  })

  it('accepts only rates between 0 and 100', () => {
    for (const value of ['0', '5', '5.000', '7.5', '100', '100.000']) {
      expect(isRate(value), value).toBe(true)
    }
    for (const value of ['100.001', '101', '-5', '5.0001', 'five', '']) {
      expect(isRate(value), value).toBe(false)
    }
    expect(formatRate('5.000')).toBe('5%')
    expect(formatRate('7.500')).toBe('7.5%')
  })

  it('previews VAT with exact arithmetic, rounded half up to three decimals like the server', () => {
    expect(previewVat('1000', '5')).toEqual({ vatAmount: '50.000', grandValue: '1050.000' })
    expect(previewVat('1234.567', '5.000')).toEqual({ vatAmount: '61.728', grandValue: '1296.295' })
    expect(previewVat('8642.013', '5')).toEqual({ vatAmount: '432.101', grandValue: '9074.114' })
    expect(previewVat('33.333', '5')).toEqual({ vatAmount: '1.667', grandValue: '35.000' })
    expect(previewVat('442.5', '5')).toEqual({ vatAmount: '22.125', grandValue: '464.625' })
    expect(previewVat('200', '0')).toEqual({ vatAmount: '0.000', grandValue: '200.000' })
    expect(previewVat('0', '5')).toEqual({ vatAmount: '0.000', grandValue: '0.000' })
    expect(previewVat('99999999999.999', '5')).toEqual({ vatAmount: '5000000000.000', grandValue: '104999999999.999' })
    // Small amounts stay exact: nothing here is a floating-point number.
    expect(previewVat('0.1', '100')).toEqual({ vatAmount: '0.100', grandValue: '0.200' })
  })

  it('shows no preview until both figures are valid', () => {
    expect(previewVat('', '5')).toBeNull()
    expect(previewVat('12.3456', '5')).toBeNull()
    expect(previewVat('100', '101')).toBeNull()
    expect(previewVat('abc', '5')).toBeNull()
  })

  it('formats a calendar day without shifting it across time zones', () => {
    expect(formatDate('2026-03-01')).toBe('1 Mar 2026')
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026')
    expect(formatDate(null)).toBe('—')
  })
})
