import Head from 'next/head'

// import Table from '../components/Table'
import NavBar from '../components/Navigation'
import Footer from '../components/Footer'
import ControlPanel from '../components/ControlPanel'

export default function Home() {
  return (
    <>
      <Head>
        <title>Ocean Node Control Panel</title>
        <meta name="description" content="Ocean Node Control Panel" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <header>
        <NavBar />
      </header>
      <main>
        <ControlPanel />
        {/* <Table /> */}
      </main>
      <footer>
        <Footer />
      </footer>
    </>
  )
}
