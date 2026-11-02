import Link from 'next/link';

import styles from './CompanyId.module.css';

export type Exchange = 'NSE' | 'BSE';

type CompanyIdProps = {
  name: string;
  symbol: string;
  exchange?: Exchange;
  /** `inline` sits inside a row; `title` heads a company page. */
  size?: 'inline' | 'title';
  /** Shows the exchange next to the symbol. Off by default: the symbol already implies NSE. */
  showExchange?: boolean;
  href?: string;
};

/**
 * Company name + ticker. The symbol is set in mono so it reads as an identifier,
 * not as prose, and stays aligned in lists.
 */
export function CompanyId({ name, symbol, exchange = 'NSE', size = 'inline', showExchange = false, href }: CompanyIdProps) {
  const body = (
    <>
      <span className={styles.name}>{name}</span>
      <span className={styles.symbol}>
        <span className="visually-hidden">, ticker </span>
        {symbol}
        {showExchange ? <span className={styles.exchange}> · {exchange}</span> : null}
      </span>
    </>
  );
  const className = `${styles.root} ${styles[size]}`;
  if (href) {
    return (
      <Link href={href} className={`${className} ${styles.link}`}>
        {body}
      </Link>
    );
  }
  return size === 'title' ? <h1 className={className}>{body}</h1> : <span className={className}>{body}</span>;
}
