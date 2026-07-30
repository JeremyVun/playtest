export const label = 'what';
export const fragments = 0;

export default function DoesItWork() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
      <h1 className="mega" style={{ fontSize: 150 }}>
        Does it work?
      </h1>
    </div>
  );
}

export const notes = `This is the whole job — and it has two readings we tend to treat separately.

DESIGN SENSE — does the UX work? Are we building the right thing?
TECHNICAL SENSE — is it buggy in the hands of users?

Every practice on the next slides is an attempt to answer one of these. The split between them is where things fall through.`;
