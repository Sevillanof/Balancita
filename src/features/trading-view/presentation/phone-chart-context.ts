import { createContext, useContext } from 'react'

/** True inside the phone view of the Terminal: the chart drops the cards and strips the phone shows elsewhere. */
export const PhoneChartContext = createContext(false)

export const usePhoneChart = (): boolean => useContext(PhoneChartContext)
