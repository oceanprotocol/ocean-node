import Head from 'next/head'

// import Table from '../components/Table'
import NavBar from '../components/Navigation'
import Footer from '../components/Footer'
import Dashboard from '../components/Dashboard'

export default function Home() {
  return (
    <>
      <Head>
        <title>Ocean nodes</title>
        <meta name="description" content="Ocean nodes dashboard" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <header>
        <NavBar />
      </header>
      <main>
        <Dashboard />
        {/* <Table /> */}
      </main>
      <footer>
        <Footer />
      </footer>
    </>
  )
}
