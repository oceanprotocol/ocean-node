import { createTheme, TableStyles, Theme } from 'react-data-table-component'

// https://github.com/jbetancur/react-data-table-component/blob/master/src/DataTable/themes.ts
const theme: Partial<Theme> = {
  text: {
    primary: 'var(-gray-gray-500)',
    secondary: 'var(--color-secondary)',
    disabled: 'var(--color-secondary)'
  },
  background: {
    default: '#fff'
  },
  divider: {
    default: 'var(--border-color)'
  }
}

createTheme('custom', theme)

// https://github.com/jbetancur/react-data-table-component/blob/master/src/DataTable/styles.ts
export const customStyles: TableStyles = {
  expanderButton: {
    style: {
      WebkitAppearance: 'none',
      width: '30px !important',
      height: '30px !important',
      background: 'transparent !important',
      border: 'transparent !important',
      color: '#A0AEC0 !important'
    }
  },
  table: {
    style: {
      scrollbarWidth: 'thin'
    }
  },
  head: {
    style: {
      fontWeight: '700'
    }
  },
  headCells: {
    style: {
      textTransform: 'uppercase',
      color: 'var(--color-secondary)',
      fontSize: 'var(--font-size-small)'
    }
  },
  rows: {
    style: {
      color: 'var(--gray-500)',
      paddingTop: '24px',
      paddingBottom: '24px'
    }
  }
}
