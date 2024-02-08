import Image from 'next/image'

import styles from './style.module.css'
import searchIcon from '../../assets/search-icon.svg'

const Search = () => {
  return (
    <div className={styles.searchOutterContainer}>
      <div className={styles.searchInnerContainer}>
        <Image src={searchIcon} alt="A magnifier." priority />
        <input
          className={styles.searchbar}
          type="text"
          id="search"
          name="searchbar"
          placeholder="Type here..."
        ></input>
      </div>
    </div>
  )
}

export default Search
